import { Node, Project, SyntaxKind, type CallExpression, type SourceFile } from "ts-morph";
import { denoScheduleToUnix, unixCronToCloudflare, type DenoCronSchedule, type DenoCronValue } from "./cron";
import { adviceFor, KV_TYPE_MAP } from "./deno-api";
import { DOCS, resolveImport, UTILS_ADVICE, type ImportMap } from "./imports";
import type { Dependency, FileKind, Finding, ScanOptions, Severity, Target } from "./types";

export interface Edit {
  start: number;
  end: number;
  text: string;
}

export interface CronEntry {
  /** exported const name in the rewritten file, e.g. exitRampCron_1 */
  exportName: string;
  schedule: string | undefined;
}

export interface FileAnalysis {
  path: string;
  outPath: string;
  kind: FileKind;
  findings: Finding[];
  edits: Edit[];
  deps: Dependency[];
  jsr: boolean;
  entry?: { type: "http" | "cron" | "email"; lastRunAt: boolean; defaultIsObject: boolean };
  denoServe: boolean;
  denoCrons: CronEntry[];
  /** Cron expression for a Val Town cron file (from options), if known. */
  valCronSchedule?: string;
  env: Set<string>;
  usesKv: boolean;
  usesD1: boolean;
  usesR2: boolean;
  usesEmail: boolean;
  usesNodeBuiltins: boolean;
  valtownTypes: { interval: boolean; email: boolean };
  /** extra bindings the user must configure (informational) */
  rewritten: boolean;
}

export interface AnalyzeContext {
  target: Target;
  importMap: ImportMap;
  options: ScanOptions;
}

export const CODE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const VAL_STD_NAMES: Record<string, { file: string; names: string[] }> = {
  sqlite: { file: "sqlite", names: ["sqlite"] },
  blob: { file: "blob", names: ["blob"] },
  email: { file: "email", names: ["email"] },
};

const posix = {
  dirname: (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ""),
  relative(fromDir: string, to: string): string {
    const a = fromDir ? fromDir.split("/") : [];
    const b = to.split("/");
    let i = 0;
    while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
    const up = a.slice(i).map(() => "..");
    const rel = [...up, ...b.slice(i)].join("/");
    return rel.startsWith(".") ? rel : "./" + rel;
  },
};

export function outPathFor(path: string): string {
  return "src/" + path.replace(/^\.?\//, "");
}

export function helperSpecifier(fromOutPath: string, helper: string): string {
  return posix.relative(posix.dirname(fromOutPath), `src/exit-ramp/${helper}`);
}

function oneLine(s: string, max = 140): string {
  const t = s.split("\n")[0].trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function isValidIdent(s: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
}

export function analyzeFile(project: Project, path: string, text: string, ctx: AnalyzeContext): FileAnalysis {
  const sf = project.createSourceFile("/" + path, text, { overwrite: true });
  const outPath = outPathFor(path);
  const a: FileAnalysis = {
    path,
    outPath,
    kind: "module",
    findings: [],
    edits: [],
    deps: [],
    jsr: false,
    denoServe: false,
    denoCrons: [],
    env: new Set(),
    usesKv: false,
    usesD1: false,
    usesR2: false,
    usesEmail: false,
    usesNodeBuiltins: false,
    valtownTypes: { interval: false, email: false },
    rewritten: false,
  };
  const workers = ctx.target === "workers";
  const headerImports = new Map<string, Set<string>>(); // specifier -> names
  const typeNames = new Set<string>();
  const seenTodo = new Set<number>();

  const find = (rule: string, severity: Severity, node: Node | undefined, message: string, docs?: string) => {
    const pos = node ? node.getStart() : 0;
    const lc = sf.getLineAndColumnAtPos(pos);
    a.findings.push({ rule, file: path, line: lc.line, column: lc.column, severity, message, snippet: node ? oneLine(node.getText()) : undefined, docs });
    if (severity === "manual" && node) {
      const stmt = node.getFirstAncestor((n) => Node.isStatement(n)) ?? (Node.isStatement(node) ? node : undefined);
      if (stmt && !seenTodo.has(stmt.getStart())) {
        seenTodo.add(stmt.getStart());
        a.edits.push({ start: stmt.getStart(), end: stmt.getStart(), text: `/* TODO(exit-ramp:${rule}): ${message.replace(/\*\//g, "* /").replace(/\s+/g, " ")} */ ` });
      }
    }
  };
  const edit = (start: number, end: number, text: string) => a.edits.push({ start, end, text });
  const addImport = (spec: string, name: string) => {
    if (!headerImports.has(spec)) headerImports.set(spec, new Set());
    headerImports.get(spec)!.add(name);
  };
  const addTypeImport = (spec: string, name: string) => {
    addImport(spec, "type " + name);
  };

  // -------- identifier used for the Workers env object ---------
  const hasEnvIdentifier = sf.getDescendants().some((n) => {
    if (!Node.isIdentifier(n) || n.getText() !== "env") return false;
    const p = n.getParent();
    return !!p && (Node.isVariableDeclaration(p) || Node.isParameterDeclaration(p) || Node.isBindingElement(p) || Node.isFunctionDeclaration(p) || Node.isImportSpecifier(p));
  });
  const envId = hasEnvIdentifier ? "cfEnv" : "env";
  const useEnvImport = () => {
    if (!workers) return;
    if (!headerImports.has("cloudflare:workers")) headerImports.set("cloudflare:workers", new Set());
    headerImports.get("cloudflare:workers")!.add(envId === "env" ? "env" : "env as cfEnv");
  };

  // ============================ kind inference ============================
  const name = path.split("/").pop() ?? path;
  let defaultFnParams: Node[] | undefined;
  let defaultIsObjectWithFetch = false;
  let defaultFetchProperty = false;
  let defaultHonoApp = false;
  const resolveDefault = () => {
    const ex = sf.getExportAssignment((e) => !e.isExportEquals());
    const fn = sf.getFunctions().find((f) => f.isDefaultExport());
    if (fn) {
      defaultFnParams = fn.getParameters();
      return;
    }
    if (!ex) return;
    let expr: Node = ex.getExpression();
    if (Node.isIdentifier(expr)) {
      const decl = expr.getSymbol()?.getDeclarations()[0];
      if (decl && Node.isVariableDeclaration(decl) && decl.getInitializer()) {
        const init = decl.getInitializer()!;
        if (/^new\s+Hono\b/.test(init.getText())) defaultHonoApp = true;
        expr = init;
      } else if (decl && Node.isFunctionDeclaration(decl)) {
        defaultFnParams = decl.getParameters();
        return;
      }
    }
    if (Node.isArrowFunction(expr) || Node.isFunctionExpression(expr)) defaultFnParams = expr.getParameters();
    else if (Node.isPropertyAccessExpression(expr) && expr.getName() === "fetch") defaultFetchProperty = true;
    else if (Node.isObjectLiteralExpression(expr) && expr.getProperty("fetch")) defaultIsObjectWithFetch = true;
    else if (Node.isNewExpression(expr) && /^Hono\b/.test(expr.getExpression().getText())) defaultHonoApp = true;
  };
  resolveDefault();

  let kind: FileKind = "module";
  const override = ctx.options.entrypoints?.[path];
  const typeText = (p: Node | undefined): string => {
    if (!p || !Node.isParameterDeclaration(p)) return "";
    return p.getTypeNode()?.getText() ?? "";
  };
  const p0 = defaultFnParams?.[0];
  if (override) kind = override;
  else if (/\.http\.[cm]?[jt]sx?$/.test(name)) kind = "http";
  else if (/\.(?:cron|interval)\.[cm]?[jt]sx?$/.test(name)) kind = "cron";
  else if (/\.email\.[cm]?[jt]sx?$/.test(name)) kind = "email";
  else if (defaultFetchProperty || defaultIsObjectWithFetch || defaultHonoApp) kind = "http";
  else if (p0) {
    const t = typeText(p0);
    const pname = Node.isParameterDeclaration(p0) ? p0.getName() : "";
    if (/\bRequest\b/.test(t) || /^(?:req|request)$/.test(pname)) kind = "http";
    else if (/\bInterval\b/.test(t)) kind = "cron";
    else if (/^(?:Email|ValTownEmail)\b/.test(t)) kind = "email";
  } else if (defaultFnParams && defaultFnParams.length === 0) {
    kind = "module";
  }
  a.kind = kind;
  const hasDefault = !!defaultFnParams || defaultFetchProperty || defaultIsObjectWithFetch || defaultHonoApp || !!sf.getExportAssignment((e) => !e.isExportEquals());
  if (kind === "http" || kind === "cron" || kind === "email") {
    if (!hasDefault) {
      find("entry-no-default-export", "manual", undefined, `${path} looks like a ${kind} val but has no default export to wire up.`);
    } else {
      a.entry = { type: kind, lastRunAt: kind === "cron" && /\blastRunAt\b/.test(text), defaultIsObject: defaultIsObjectWithFetch };
    }
    if (kind === "cron") a.valCronSchedule = ctx.options.crons?.[path];
    if (kind === "email" && !workers) {
      find("val-email", "manual", sf.getExportAssignment((e) => !e.isExportEquals()) ?? undefined, "Email vals have no Node equivalent: receive mail through your mail provider's webhook instead.", DOCS.migrateEmail);
      a.entry = undefined;
    }
  }

  // ================================ imports ================================
  type SpecNode = { lit: Node; value: string; names?: { default?: boolean; ns?: boolean; named: string[] }; decl: Node };
  const specs: SpecNode[] = [];
  for (const d of sf.getImportDeclarations()) {
    const lit = d.getModuleSpecifier();
    if (lit) specs.push({ lit, value: d.getModuleSpecifierValue(), names: { default: !!d.getDefaultImport(), ns: !!d.getNamespaceImport(), named: d.getNamedImports().map((n) => n.getName()) }, decl: d });
  }
  for (const d of sf.getExportDeclarations()) {
    const lit = d.getModuleSpecifier();
    if (lit) specs.push({ lit, value: d.getModuleSpecifierValue()!, decl: d });
  }
  for (const c of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (c.getExpression().getKind() !== SyntaxKind.ImportKeyword) continue;
    const arg = c.getArguments()[0];
    if (arg && Node.isStringLiteral(arg)) specs.push({ lit: arg, value: arg.getLiteralValue(), decl: c });
  }

  for (const s of specs) {
    if (s.value.startsWith("node:")) {
      a.usesNodeBuiltins = true;
      continue;
    }
    const r = resolveImport(s.value, { importMap: ctx.importMap, target: ctx.target });
    if (!r) continue;
    const quote = s.lit.getText()[0];
    const replaceSpec = (spec: string) => edit(s.lit.getStart(), s.lit.getEnd(), quote + spec + quote);

    if (r.kind === "valtown-std") {
      const std = r.std!.replace(/@.*$/, "");
      r.rule = `import-valtown-std-${std}`;
      const meta = VAL_STD_NAMES[std];
      if (workers && meta) {
        const bad = s.names ? [...(s.names.default ? ["default"] : []), ...(s.names.ns ? ["* as ns"] : []), ...s.names.named.filter((n) => !meta.names.includes(n))] : [];
        if (bad.length) {
          find(r.rule, "manual", s.decl, `std/${std}: imports ${bad.join(", ")} have no equivalent in the generated helper (it exports ${meta.names.join(", ")}). Port these by hand.`, DOCS.mapping);
          continue;
        }
        replaceSpec(helperSpecifier(outPath, meta.file));
        a.rewritten = true;
        if (std === "sqlite") {
          a.usesD1 = true;
          const global = /\/global(?:\.ts)?$/.test(r.spec.split("?")[0]);
          find(r.rule, "review", s.decl, `std/sqlite -> Cloudflare D1 (binding DB) through a libsql-shaped helper. D1 is not libsql: named params are rewritten, rows are plain objects, batch() is one transaction. Create the database and import your data first (see the migrate-sqlite guide).${global ? " This imports the account-global database: copy only the tables this app uses." : ""}`, DOCS.migrateSqlite);
        } else if (std === "blob") {
          a.usesR2 = true;
          find(r.rule, "review", s.decl, "std/blob -> Cloudflare R2 (binding BLOB) through a blob-shaped helper. Copy the bytes across first (see the migrate-blobs guide). Private objects stay private: serve them through an authenticated route.", DOCS.migrateBlobs);
        } else {
          a.usesEmail = true;
          find(r.rule, "review", s.decl, "std/email -> Cloudflare Email Service (binding EMAIL). Needs a domain on Cloudflare DNS, an onboarded sender, and the EXIT_RAMP_EMAIL_FROM secret. Val Town's default sender and recipient do not exist on Cloudflare.", DOCS.migrateEmail);
        }
      } else if (std === "openai") {
        find(r.rule, "manual", s.decl, "std/openai has no drop-in replacement. Use the openai npm package with a Cloudflare AI Gateway base URL and your own API key.", DOCS.migrateAi);
      } else if (std === "utils") {
        const used = s.names?.named ?? [];
        const lines = used.length ? used.map((n) => `${n}: ${UTILS_ADVICE[n] ?? "no automatic mapping"}`).join(" | ") : Object.keys(UTILS_ADVICE).join(", ");
        find(r.rule, "manual", s.decl, `std/utils is Val Town specific. ${lines}`, DOCS.migrateCode);
      } else if (meta) {
        find(r.rule, "manual", s.decl, `std/${std}: no Node-target helper is generated. Replace it with a storage/email service you run.`, DOCS.mapping);
      } else {
        find(r.rule, "manual", s.decl, `std/${std} is a Val Town standard-library module with no mapping in exit-ramp. Check https://docs.val.town/migration/cloudflare for a replacement.`, DOCS.mapping);
      }
      continue;
    }

    if (r.newSpec) {
      replaceSpec(r.newSpec);
      a.rewritten = true;
    }
    if (r.dep) a.deps.push(r.dep);
    if (r.kind === "jsr") a.jsr = true;
    find(r.rule, r.severity, s.decl, r.message, r.docs);
  }

  // /** @jsxImportSource https://esm.sh/react@18 */ pragmas name a module too
  for (const m of text.matchAll(/@jsxImportSource\s+(\S+)/g)) {
    const spec = m[1].replace(/\*\/$/, "");
    const r = resolveImport(spec, { importMap: ctx.importMap, target: ctx.target });
    if (r?.newSpec) {
      const at = (m.index ?? 0) + m[0].indexOf(spec);
      edit(at, at + spec.length, r.newSpec);
      if (r.dep) a.deps.push(r.dep);
      a.rewritten = true;
      const lc = sf.getLineAndColumnAtPos(m.index ?? 0);
      a.findings.push({ rule: "jsx-import-source", file: path, line: lc.line, column: lc.column, severity: "auto", message: `@jsxImportSource ${spec} -> ${r.newSpec}${r.dep ? ` (package.json: ${r.dep.name}@${r.dep.range})` : ""}. Install the package and its JSX runtime.`, snippet: m[0] });
    } else if (r && r.severity === "manual") {
      const lc = sf.getLineAndColumnAtPos(m.index ?? 0);
      a.findings.push({ rule: "jsx-import-source", file: path, line: lc.line, column: lc.column, severity: "manual", message: `@jsxImportSource ${spec}: ${r.message}`, snippet: m[0] });
    }
  }

  // ============================== Deno.* APIs ==============================
  const consumed: [number, number][] = [];
  const inConsumed = (n: Node) => consumed.some(([s, e]) => n.getStart() >= s && n.getEnd() <= e);
  const calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
  const calleeText = (c: CallExpression) => c.getExpression().getText();

  // ---- Deno.serve ----
  for (const c of calls.filter((c) => calleeText(c) === "Deno.serve")) {
    const stmt = c.getParent();
    const args = c.getArguments();
    const topLevel = Node.isExpressionStatement(stmt) && stmt.getParent() === sf;
    let handler: Node | undefined;
    if (args.length >= 2) handler = args[1];
    else if (args.length === 1) {
      const o = args[0];
      if (Node.isObjectLiteralExpression(o)) {
        const prop = o.getProperty("handler");
        if (prop && Node.isPropertyAssignment(prop)) handler = prop.getInitializer();
        else if (prop && Node.isShorthandPropertyAssignment(prop)) handler = prop.getNameNode();
        else if (prop && Node.isMethodDeclaration(prop)) handler = undefined;
      } else handler = o;
    }
    consumed.push([c.getExpression().getStart(), c.getExpression().getEnd()]);
    if (!workers) {
      if (topLevel && handler) {
        a.denoServe = true;
        edit(c.getStart(), handler.getStart(), "export const exitRampFetch = ");
        edit(handler.getEnd(), c.getEnd(), "");
        a.rewritten = true;
        a.kind = "http";
        find("deno-serve", "review", c, "Deno.serve -> exported handler served by the generated Node server (src/server.ts). Options such as port/hostname are ignored: set PORT.", DOCS.denoIssue);
      } else find("deno-serve", "manual", c, "Deno.serve must be a top-level statement with a handler function to be converted.", DOCS.denoIssue);
      continue;
    }
    if (!topLevel || !handler) {
      find("deno-serve", "manual", c, "Deno.serve is used in a way that cannot be rewritten automatically (not a top-level statement, or no handler found). Export a fetch handler by hand.", DOCS.migrateCode);
      continue;
    }
    a.denoServe = true;
    a.kind = "http";
    edit(c.getStart(), handler.getStart(), "export const exitRampFetch = ");
    edit(handler.getEnd(), c.getEnd(), "");
    a.rewritten = true;
    let note = "Deno.serve -> exported handler wired into a Workers fetch() handler. ";
    let sev: Severity = "auto";
    const opts = args.length === 2 ? args[0] : undefined;
    if (opts && Node.isObjectLiteralExpression(opts) && opts.getProperties().length) {
      note += "Serve options (port, hostname, onListen, signal...) are ignored on Workers. ";
      sev = "review";
    }
    const params = Node.isArrowFunction(handler) || Node.isFunctionExpression(handler) ? handler.getParameters() : [];
    if (params.length >= 2) {
      note += "The second argument (Deno's ServeHandlerInfo) is passed as a shim: remoteAddr.hostname comes from the cf-connecting-ip header. ";
      sev = "review";
    }
    find("deno-serve", sev, c, note.trim(), DOCS.migrateCode);
  }

  // ---- Deno.cron ----
  let cronN = 0;
  for (const c of calls.filter((c) => calleeText(c) === "Deno.cron")) {
    consumed.push([c.getExpression().getStart(), c.getExpression().getEnd()]);
    const stmt = c.getParent();
    const args = c.getArguments();
    const topLevel = Node.isExpressionStatement(stmt) && stmt.getParent() === sf;
    if (!topLevel || args.length < 3) {
      find("deno-cron", "manual", c, "Deno.cron must be a top-level statement with (name, schedule, handler) to be converted.", DOCS.migrateCrons);
      continue;
    }
    const handler = args[args.length - 1];
    const nameArg = args[0];
    const schedArg = args[1];
    const opts = args.length === 4 ? args[2] : undefined;
    let schedule: string | undefined;
    let sev: Severity = "auto";
    const notes: string[] = [];
    let scheduleText = schedArg.getText();
    if (Node.isStringLiteral(schedArg) || Node.isNoSubstitutionTemplateLiteral(schedArg)) {
      const conv = unixCronToCloudflare(schedArg.getLiteralValue());
      if (conv.ok) {
        schedule = conv.expr;
        scheduleText = JSON.stringify(conv.expr);
        if (conv.expr !== schedArg.getLiteralValue()) {
          sev = "review";
          notes.push(...conv.notes);
        }
      } else {
        sev = "manual";
        notes.push(`schedule ${schedArg.getText()}: ${conv.notes.join("; ")}`);
      }
    } else if (Node.isObjectLiteralExpression(schedArg)) {
      const sched = readDenoSchedule(schedArg);
      if (sched) {
        const conv = denoScheduleToUnix(sched);
        const cf = unixCronToCloudflare(conv.expr);
        schedule = cf.ok ? cf.expr : undefined;
        scheduleText = JSON.stringify(schedule ?? conv.expr);
        sev = "review";
        notes.push(`object schedule converted to "${schedule ?? conv.expr}"`, ...cf.notes);
      } else {
        sev = "manual";
        notes.push("object schedule uses values that could not be read statically");
      }
    } else {
      sev = "manual";
      notes.push("schedule is computed at runtime: copy the resulting cron expression into wrangler.toml [triggers].crons");
    }
    if (opts && /backoffSchedule/.test(opts.getText())) {
      sev = sev === "manual" ? sev : "review";
      notes.push("backoffSchedule retries do not exist: a failed scheduled() run is not retried automatically. Make the job safe to re-run or use Queues");
    }
    cronN++;
    const exportName = `exitRampCron_${cronN}`;
    edit(c.getStart(), handler.getStart(), `export const ${exportName} = { name: ${nameArg.getText()}, schedule: ${scheduleText}, run: `);
    edit(handler.getEnd(), c.getEnd(), " }");
    a.denoCrons.push({ exportName, schedule });
    a.rewritten = true;
    a.kind = a.kind === "module" ? "cron" : a.kind;
    find("deno-cron", sev, c, `Deno.cron -> scheduled() handler + cron trigger${schedule ? ` "${schedule}" (UTC)` : ""}. ${notes.join(". ")}${notes.length ? "." : ""} Cron Triggers run on UTC like Deno.cron; changes can take minutes to propagate.`.trim(), DOCS.migrateCrons);
  }

  // ---- Deno.env ----
  const envCalls = calls.filter((c) => /^Deno\.env\.(get|has|toObject|set|delete)$/.test(calleeText(c)));
  for (const c of envCalls) {
    const method = calleeText(c).split(".")[2];
    consumed.push([c.getStart(), c.getEnd()]);
    const arg = c.getArguments()[0];
    const lit = arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg)) ? arg.getLiteralValue() : undefined;
    const ref = workers ? envId : "process.env";
    if (workers && method !== "set" && method !== "delete") useEnvImport();
    if (method === "get") {
      if (lit !== undefined) {
        a.env.add(lit);
        edit(c.getStart(), c.getEnd(), isValidIdent(lit) ? `${ref}.${lit}` : `${ref}[${arg!.getText()}]`);
        a.rewritten = true;
        if (/^(?:valtown|VAL_TOWN_API_KEY|VALTOWN_.*)$/i.test(lit)) {
          find("valtown-api-token", "manual", c, `${lit} is the Val Town API token injected into every val. It stops working when Val Town shuts down. Remove the code that depends on it (std/* services are mapped separately).`, DOCS.secrets);
        } else if (/^(?:VAL_TOWN_|valtown)/i.test(lit)) {
          find("valtown-env", "review", c, `${lit} looks Val Town specific.`, DOCS.secrets);
        }
      } else if (arg) {
        edit(c.getStart(), c.getEnd(), workers ? `(${ref} as unknown as Record<string, string | undefined>)[${arg.getText()}]` : `process.env[${arg.getText()}]`);
        a.rewritten = true;
        find("deno-env", "review", c, "Deno.env.get with a computed name: the variable cannot be listed for wrangler/.dev.vars. Declare it by hand.", DOCS.secrets);
      }
    } else if (method === "has" && arg) {
      edit(c.getStart(), c.getEnd(), workers ? `(${arg.getText()} in ${ref})` : `(${arg.getText()} in process.env)`);
      a.rewritten = true;
      if (lit !== undefined) a.env.add(lit);
    } else if (method === "toObject") {
      edit(c.getStart(), c.getEnd(), workers ? `Object.fromEntries(Object.entries(${ref}).filter(([, v]) => typeof v === "string"))` : `{ ...process.env }`);
      a.rewritten = true;
      find("deno-env-toObject", "review", c, "Deno.env.toObject() listed only string variables. On Workers the env object also holds bindings (KV, D1...), which are filtered out here; vars that are not declared in wrangler.toml are absent.", DOCS.secrets);
    } else {
      find("deno-env-write", "manual", c, `Deno.env.${method} cannot be converted: Worker env is read-only. Keep mutable state in a module variable or KV.`, DOCS.secrets);
    }
  }
  if (a.env.size) {
    find("deno-env", "info", undefined, `Env vars used: ${[...a.env].sort().join(", ")}. Declared in .dev.vars.example and src/env.d.ts; set them with \`wrangler secret put NAME\` (see the transfer-secrets guide).`, DOCS.secrets);
  }

  // ---- Deno.openKv ----
  const kvCalls = calls.filter((c) => calleeText(c) === "Deno.openKv");
  const kvTypeRefs = sf.getDescendantsOfKind(SyntaxKind.TypeReference).filter((r) => /^Deno\.(?:Kv|Atomic)/.test(r.getTypeName().getText()));
  const kvAnchor: Node | undefined = kvCalls[0] ?? kvTypeRefs[0];
  if (kvAnchor) {
    const kvSpec = helperSpecifier(outPath, "kv");
    for (const c of kvCalls) {
      consumed.push([c.getStart(), c.getEnd()]);
      if (!workers) {
        find("deno-kv", "manual", c, "Deno KV has no Node equivalent in exit-ramp. Use node:sqlite, a database, or Redis. (Workers is the supported target for KV conversion.)", DOCS.denoKv);
        continue;
      }
      const arg = c.getArguments()[0];
      const argText = arg && !/^["'`]/.test(arg.getText()) ? "" : "";
      edit(c.getStart(), c.getEnd(), `openKv(${argText})`);
      addImport(kvSpec, "openKv");
      a.usesKv = true;
      a.rewritten = true;
      if (arg && Node.isStringLiteral(arg)) {
        find("deno-kv-path", "info", c, `Deno.openKv(${arg.getText()}): the path is ignored; data lives in the KV namespace bound as KV.`, DOCS.denoKv);
      }
    }
    if (workers) {
      find("deno-kv", "review", kvAnchor, "Deno KV -> Workers KV (binding KV) through a Deno-KV-shaped helper. Differences you must accept or design around: (1) eventual consistency, changes can take 60s+ to show in other locations and Deno KV reads are strongly consistent by default; (2) no transactions or versionstamps; (3) one write per second per key; (4) keys become strings (tuple keys are encoded by src/exit-ramp/kv-codec.ts, so existing data must be re-imported with the same encoder: migrate/deno-kv-export.ts); (5) list() reads 1 + N requests per page and does start/end/reverse in memory.", DOCS.kvConsistency);
      const kvVar = (() => {
        if (!kvCalls[0]) return undefined;
        const p = kvCalls[0].getParent();
        const anc = p && Node.isAwaitExpression(p) ? p.getParent() : p;
        return anc && Node.isVariableDeclaration(anc) ? anc.getName() : undefined;
      })();
      const recv = (c: CallExpression) => {
        const e = c.getExpression();
        return Node.isPropertyAccessExpression(e) ? e.getExpression().getText() : "";
      };
      const isKvRecv = (r: string) => (kvVar && r === kvVar) || /kv/i.test(r);
      const chainNames = (c: CallExpression): string[] => {
        const names: string[] = [];
        let cur: Node | undefined = c;
        while (cur) {
          const par: Node | undefined = cur.getParent();
          if (par && Node.isPropertyAccessExpression(par) && par.getExpression() === cur) {
            const call = par.getParent();
            if (call && Node.isCallExpression(call) && call.getExpression() === par) {
              names.push(par.getName());
              cur = call;
              continue;
            }
          }
          break;
        }
        return names;
      };
      let tuple = false;
      for (const c of calls) {
        const e = c.getExpression();
        if (!Node.isPropertyAccessExpression(e)) continue;
        const m = e.getName();
        if (m === "atomic" && isKvRecv(recv(c))) {
          const chain = chainNames(c);
          const bad = chain.filter((n) => ["sum", "min", "max", "enqueue"].includes(n));
          if (chain.includes("check")) find("deno-kv-atomic-check", "manual", c, "atomic().check() (compare-and-set with versionstamps) cannot be done on Workers KV. The helper throws at commit() so this never fails silently. Move this key to a Durable Object or D1, or open the store with { unsafeBestEffortChecks: true } and accept a race.", DOCS.kvConsistency);
          else if (bad.length) find("deno-kv-atomic-ops", "manual", c, `atomic().${bad.join("/")} is not supported on Workers KV (the helper throws). Counters and queues need Durable Objects, D1 or Queues.`, DOCS.kvConsistency);
          else find("deno-kv-atomic", "review", c, "atomic() is NOT atomic here: the operations run one after another and a failure can leave some applied. Fine for independent writes; unsafe for invariants across keys.", DOCS.kvConsistency);
        } else if ((m === "enqueue" || m === "listenQueue") && isKvRecv(recv(c))) {
          find("deno-kv-queue", "manual", c, `kv.${m} (Deno KV queues) needs Cloudflare Queues: create a queue, send() from the producer, and add a queue() consumer.`, "https://developers.cloudflare.com/queues/");
        } else if (m === "watch" && isKvRecv(recv(c))) {
          find("deno-kv-watch", "manual", c, "kv.watch has no Workers KV equivalent. Use Durable Objects with WebSockets, or poll.", DOCS.kvConsistency);
        } else if (m === "list" && isKvRecv(recv(c))) {
          const txt = c.getArguments().map((x) => x.getText()).join(",");
          if (/\b(reverse|start|end)\b/.test(txt)) find("deno-kv-list-range", "review", c, "list() with reverse/start/end is filtered (and reversed) in memory after listing the common prefix. Fine for small key sets; slow for large ones.", DOCS.kvLimits);
        }
      }
      for (const arr of sf.getDescendantsOfKind(SyntaxKind.ArrayLiteralExpression)) {
        const par = arr.getParent();
        if (!par || !Node.isCallExpression(par)) continue;
        const pe = par.getExpression();
        if (Node.isPropertyAccessExpression(pe) && ["get", "set", "delete", "list"].includes(pe.getName()) && arr.getElements().length > 1 && isKvRecv(recv(par))) tuple = true;
      }
      if (tuple) find("deno-kv-tuple-keys", "info", kvAnchor, "Multi-part keys such as [\"users\", id] are encoded into one string key that sorts in the same order as Deno KV (see src/exit-ramp/kv-codec.ts). Keys over 512 bytes after encoding are rejected.", DOCS.kvLimits);
    }
  }

  // ---- Deno.* type references ----
  for (const ref of sf.getDescendantsOfKind(SyntaxKind.TypeReference)) {
    const tn = ref.getTypeName().getText();
    const m = tn.match(/^Deno\.(\w+)$/);
    if (!m) continue;
    if (KV_TYPE_MAP[m[1]] && workers) {
      edit(ref.getTypeName().getStart(), ref.getTypeName().getEnd(), KV_TYPE_MAP[m[1]]);
      addTypeImport(helperSpecifier(outPath, "kv"), KV_TYPE_MAP[m[1]]);
      consumed.push([ref.getStart(), ref.getTypeName().getEnd()]);
      a.usesKv = true;
      a.rewritten = true;
    } else if (m[1] === "ServeHandlerInfo") {
      edit(ref.getStart(), ref.getEnd(), `{ remoteAddr: { transport: "tcp"; hostname: string; port: number } }`);
      consumed.push([ref.getStart(), ref.getEnd()]);
      a.rewritten = true;
    }
  }

  // ---- leftover Deno.* ----
  const seenMember = new Set<string>();
  for (const pa of sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    if (pa.getExpression().getText() !== "Deno") continue;
    if (inConsumed(pa)) continue;
    const member = pa.getName();
    const adv = adviceFor(member);
    const key = member + ":" + pa.getStart();
    if (seenMember.has(key)) continue;
    seenMember.add(key);
    find(`deno-${member}`, adv.severity, pa, `Deno.${member}: ${adv.message}`, DOCS.migrateCode);
  }
  for (const q of sf.getDescendantsOfKind(SyntaxKind.QualifiedName)) {
    if (q.getLeft().getText() !== "Deno") continue;
    if (inConsumed(q)) continue;
    find(`deno-type-${q.getRight().getText()}`, "review", q, `Type Deno.${q.getRight().getText()} does not exist outside Deno. Replace it with a Web or @cloudflare/workers-types type.`, DOCS.migrateCode);
  }

  // =============================== Val Town specifics ===============================
  const lines = text.split("\n");
  lines.forEach((ln, i) => {
    if (/^\s*(?:import|export)\b[^\n]*\bfrom\b/.test(ln)) return;
    for (const m of ln.matchAll(/https?:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]*\.val\.run[^\s"'`)]*|[A-Za-z0-9._%+-]+@valtown\.email|https:\/\/esm\.town\/[^\s"'`)]+/g)) {
      a.findings.push({ rule: "valtown-url", file: path, line: i + 1, column: (m.index ?? 0) + 1, severity: "review", message: `"${m[0]}" is a Val Town address that stops working on 2027-01-10. Replace it with the new URL/address (and add a redirect for old links: https://docs.val.town/migration/redirects).`, snippet: oneLine(ln.trim()), docs: "https://docs.val.town/migration/redirects" });
    }
  });

  // Val Town ambient types
  for (const ref of sf.getDescendantsOfKind(SyntaxKind.TypeReference)) {
    const tn = ref.getTypeName().getText();
    if ((tn === "Interval" || tn === "Email") && !sf.getInterface(tn) && !sf.getTypeAlias(tn) && !specs.some((s) => s.names?.named.includes(tn))) {
      if (tn === "Interval") a.valtownTypes.interval = true;
      else a.valtownTypes.email = true;
    }
  }

  // header imports (one edit at the top, after a shebang if present)
  if (headerImports.size) {
    const body = [...headerImports.entries()]
      .map(([spec, names]) => {
        const plain = [...names].filter((n) => !n.startsWith("type ")).sort();
        const types = [...names].filter((n) => n.startsWith("type ")).sort();
        return `import { ${[...plain, ...types].join(", ")} } from "${spec}";`;
      })
      .join("\n");
    const pos = text.startsWith("#!") ? text.indexOf("\n") + 1 : 0;
    edit(pos, pos, body + "\n");
  }

  if (kind === "email" && workers && a.entry) {
    find("val-email", "review", sf.getExportAssignment((e) => !e.isExportEquals()) ?? sf.getFunctions().find((f) => f.isDefaultExport()), "Email val -> Worker email() handler. The raw message is parsed with postal-mime into Val Town's Email shape. Route the address to the Worker in Email Routing; old @valtown.email addresses do not transfer.", DOCS.migrateEmail);
  }
  if (kind === "cron" && a.entry) {
    const conv = a.valCronSchedule ? unixCronToCloudflare(a.valCronSchedule) : undefined;
    if (!a.valCronSchedule) {
      find("val-cron-schedule", "manual", sf.getFunctions().find((f) => f.isDefaultExport()) ?? sf.getExportAssignment((e) => !e.isExportEquals()), "The cron schedule of a Val Town cron val lives in its trigger settings, not in the source. Pass it with --cron <file>=\"<expr>\" or exit-ramp.config.json; until then no trigger is written to wrangler.toml (Val Town schedules run in UTC, like Cloudflare).", DOCS.migrateCrons);
    } else if (conv && !conv.ok) {
      find("val-cron-schedule", "manual", undefined, `Schedule "${a.valCronSchedule}": ${conv.notes.join("; ")}`, DOCS.migrateCrons);
      a.valCronSchedule = undefined;
    } else if (conv) {
      a.valCronSchedule = conv.expr;
      find("val-cron-schedule", conv.notes.length ? "review" : "auto", undefined, `Cron schedule "${conv.expr}" (UTC).${conv.notes.length ? " " + conv.notes.join("; ") + "." : ""} Disable the Val Town schedule before enabling the Cloudflare one and verify a real run.`, DOCS.migrateCrons);
    }
    if (a.entry.lastRunAt) {
      find("val-cron-lastRunAt", "review", undefined, "This cron reads interval.lastRunAt. Cloudflare does not pass it, so the generated worker stores the last successful run in Workers KV (binding KV, key exit-ramp:last-run:<file>). KV is eventually consistent: make the job safe to repeat.", DOCS.migrateCrons);
    }
  }
  if (kind === "http" && a.entry && !a.denoServe) {
    find("val-http", "auto", undefined, "HTTP val -> Worker fetch() handler (wired in src/worker.ts). Routes, methods, headers, status codes and streaming are unchanged because both sides use Request/Response.", DOCS.migrateCode);
  }
  if (a.usesNodeBuiltins && workers) {
    find("node-builtins", "info", undefined, "node: imports need the nodejs_compat flag (set in wrangler.toml). Workers supports only part of Node's API: https://developers.cloudflare.com/workers/runtime-apis/nodejs/", DOCS.nodeCompat);
  }

  return a;
}

function readDenoSchedule(o: Node): DenoCronSchedule | undefined {
  if (!Node.isObjectLiteralExpression(o)) return undefined;
  const out: DenoCronSchedule = {};
  for (const p of o.getProperties()) {
    if (!Node.isPropertyAssignment(p)) return undefined;
    const key = p.getName() as keyof DenoCronSchedule;
    if (!["minute", "hour", "dayOfMonth", "month", "dayOfWeek"].includes(key)) return undefined;
    const v = readValue(p.getInitializer());
    if (v === null) return undefined;
    out[key] = v;
  }
  return out;
}

function readNumber(n: Node | undefined): number | undefined {
  if (!n) return undefined;
  const t = n.getText();
  return /^-?\d+$/.test(t) ? Number(t) : undefined;
}

function readValue(n: Node | undefined): DenoCronValue | null {
  if (!n) return null;
  const num = readNumber(n);
  if (num !== undefined) return num;
  if (!Node.isObjectLiteralExpression(n)) return null;
  const f: { exact?: number | number[]; start?: number; end?: number; every?: number } = {};
  for (const p of n.getProperties()) {
    if (!Node.isPropertyAssignment(p)) return null;
    const k = p.getName();
    const init = p.getInitializer();
    if (k === "exact") {
      if (init && Node.isArrayLiteralExpression(init)) {
        const arr = init.getElements().map((e) => readNumber(e));
        if (arr.some((x) => x === undefined)) return null;
        f.exact = arr as number[];
      } else {
        const x = readNumber(init);
        if (x === undefined) return null;
        f.exact = x;
      }
    } else if (k === "start" || k === "end" || k === "every") {
      const x = readNumber(init);
      if (x === undefined) return null;
      f[k] = x;
    } else return null;
  }
  return f;
}

export function applyEdits(text: string, edits: Edit[]): { text: string; dropped: Edit[] } {
  const sorted = [...edits].sort((x, y) => y.start - x.start || y.end - x.end);
  const dropped: Edit[] = [];
  let out = text;
  let lowest = Infinity;
  for (const e of sorted) {
    // an edit that overlaps one already applied (to its right) is dropped, except zero-length inserts at the same spot
    if (e.end > lowest) {
      dropped.push(e);
      continue;
    }
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    lowest = e.start;
  }
  return { text: out, dropped };
}

export function newProject(): Project {
  return new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    skipLoadingLibFiles: true,
    compilerOptions: { allowJs: true, jsx: 1 /* Preserve */, target: 99, noLib: true },
  });
}

export type { SourceFile };
