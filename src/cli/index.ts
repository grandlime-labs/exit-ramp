import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { convert, renderGithubSummary, renderJson, renderMarkdown, renderText, scan, type ConvertOptions, type InputFile, type ScanResult } from "../core/index";
import { exportVals, ValTownApiError } from "../core/exporter";

export interface IO {
  out: (s: string) => void;
  err: (s: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  fetch?: typeof fetch;
}

const HELP = `exit-ramp: move Val Town and Deno Deploy code to Cloudflare Workers (Node as a secondary target)

Usage
  exit-ramp scan <dir>              Analyze only. Free. Never writes files.
  exit-ramp convert <dir> --out D   Rewrite into a ready-to-run Worker project in D.
  exit-ramp export [--val user/name] --out D
                                    Download your Val Town source (read-only GET requests).
                                    Token comes from the VAL_TOWN_API_KEY environment variable.

Options
  --target workers|node       Output target (default workers)
  --format text|json|markdown|github-summary     scan output format (default text)
  --cron <file>=<expr>        Cron schedule for a Val Town cron val (repeatable). Not in the source or the Val Town API.
  --entry <file>=http|cron|email   Treat a file as that val type (repeatable)
  --config <path>             JSON config (default <dir>/exit-ramp.config.json): target, projectName, compatibilityDate, crons, entrypoints
  --name <name>               Project/worker name for convert
  --compat-date YYYY-MM-DD    wrangler compatibility_date (default 2026-10-01)
  --fail-under <n>            scan: exit 1 if the overall confidence is below n
  --fail-on-manual            scan: exit 1 if any finding needs manual work
  --force                     convert/export: write into a non-empty directory (never deletes files)
  -h, --help
`;

const SKIP_DIRS = new Set(["node_modules", ".git", ".wrangler", "dist", "out", ".vscode", ".idea"]);
const MAX_FILE = 2 * 1024 * 1024;

export function readDir(root: string, warnings: string[] = []): InputFile[] {
  const files: InputFile[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(p);
        continue;
      }
      const rel = relative(root, p).split("\\").join("/");
      if (st.size > MAX_FILE) {
        warnings.push(`${rel}: larger than 2 MB, skipped`);
        continue;
      }
      const buf = readFileSync(p);
      if (buf.includes(0)) {
        warnings.push(`${rel}: binary file, skipped (copy it into the new project yourself)`);
        continue;
      }
      files.push({ path: rel, text: buf.toString("utf8") });
    }
  };
  const st = statSync(root);
  if (st.isFile()) return [{ path: root.split(/[\\/]/).pop()!, text: readFileSync(root, "utf8") }];
  walk(root);
  return files;
}

function kv(list: string[] | undefined, what: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of list ?? []) {
    const i = item.indexOf("=");
    if (i < 1) throw new UsageError(`${what} expects <file>=<value>, got "${item}"`);
    out[item.slice(0, i)] = item.slice(i + 1);
  }
  return out;
}

class UsageError extends Error {}

function loadConfig(path: string | undefined, dir: string): Partial<ConvertOptions> {
  const p = path ? resolve(path) : join(dir, "exit-ramp.config.json");
  if (!existsSync(p)) {
    if (path) throw new UsageError(`Config not found: ${path}`);
    return {};
  }
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Partial<ConvertOptions>;
  } catch (e) {
    throw new UsageError(`Invalid JSON in ${p}: ${(e as Error).message}`);
  }
}

function writeOut(dir: string, files: { path: string; content: string }[], force: boolean): void {
  if (existsSync(dir) && readdirSync(dir).length && !force) throw new UsageError(`${dir} is not empty. Choose another --out or pass --force (existing files with the same names are overwritten; nothing is deleted).`);
  for (const f of files) {
    const p = join(dir, f.path);
    const rel = relative(dir, p);
    if (rel.startsWith("..")) throw new Error(`Refusing to write outside ${dir}: ${f.path}`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content);
  }
}

function format(r: ScanResult, fmt: string): string {
  switch (fmt) {
    case "json":
      return renderJson(r);
    case "markdown":
      return renderMarkdown(r);
    case "github-summary":
      return renderGithubSummary(r);
    case "text":
      return renderText(r);
    default:
      throw new UsageError(`Unknown --format ${fmt}`);
  }
}

export async function main(argv: string[], io: IO): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        target: { type: "string" },
        format: { type: "string" },
        out: { type: "string", short: "o" },
        cron: { type: "string", multiple: true },
        entry: { type: "string", multiple: true },
        config: { type: "string" },
        name: { type: "string" },
        "compat-date": { type: "string" },
        "fail-under": { type: "string" },
        "fail-on-manual": { type: "boolean" },
        force: { type: "boolean" },
        val: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    const [cmd, dirArg] = positionals;
    if (values.help || !cmd) {
      io.out(HELP);
      return cmd || values.help ? 0 : 2;
    }

    if (cmd === "export") {
      const token = io.env.VAL_TOWN_API_KEY;
      if (!token) throw new UsageError("Set the VAL_TOWN_API_KEY environment variable to a Val Town API token with read access. (Tokens are never accepted as flags: they would end up in shell history.)");
      if (!values.out) throw new UsageError("export needs --out <dir>");
      const out = resolve(io.cwd, values.out);
      const vals = await exportVals({ token, val: values.val, fetch: io.fetch, onProgress: (m) => io.err(m) });
      for (const v of vals) {
        const dir = join(out, v.name);
        const config = { entrypoints: v.entrypoints, crons: {} as Record<string, string> };
        const files = [
          ...v.files.map((f) => ({ path: f.path, content: f.text })),
          { path: "exit-ramp.config.json", content: JSON.stringify(config, null, 2) + "\n" },
          { path: "ENV_VARS.txt", content: `# Names only: Val Town's API never returns values. Re-enter them as Worker secrets.\n${v.envVarNames.join("\n")}\n` },
        ];
        writeOut(dir, files, values.force ?? false);
        io.out(`exported ${v.name}: ${v.files.length} file(s), ${v.envVarNames.length} env var name(s) -> ${dir}`);
      }
      io.out("Cron schedules are not available through the API: add them under \"crons\" in exit-ramp.config.json (file -> expression).");
      return 0;
    }

    if (cmd !== "scan" && cmd !== "convert") throw new UsageError(`Unknown command "${cmd}". Try --help.`);
    if (!dirArg) throw new UsageError(`${cmd} needs a directory (or a single file).`);
    const dir = resolve(io.cwd, dirArg);
    if (!existsSync(dir)) throw new UsageError(`${dirArg} does not exist.`);
    const isFile = statSync(dir).isFile();
    const cfg = loadConfig(values.config, isFile ? dirname(dir) : dir);
    const target = (values.target ?? cfg.target ?? "workers") as string;
    if (target !== "workers" && target !== "node") throw new UsageError(`--target must be workers or node`);
    const entries = { ...(cfg.entrypoints ?? {}), ...kv(values.entry, "--entry") } as Record<string, "http" | "cron" | "email">;
    for (const [f, k] of Object.entries(entries)) if (!["http", "cron", "email"].includes(k)) throw new UsageError(`--entry ${f}=${k}: must be http, cron or email`);
    const options: ConvertOptions = {
      target,
      entrypoints: entries,
      crons: { ...(cfg.crons ?? {}), ...kv(values.cron, "--cron") },
      projectName: values.name ?? cfg.projectName,
      compatibilityDate: values["compat-date"] ?? cfg.compatibilityDate,
    };
    if (options.compatibilityDate && !/^\d{4}-\d{2}-\d{2}$/.test(options.compatibilityDate)) throw new UsageError("--compat-date must look like 2026-10-01");

    const readWarnings: string[] = [];
    const files = readDir(dir, readWarnings);
    if (cmd === "scan") {
      const r = scan(files, options);
      r.warnings.push(...readWarnings);
      io.out(format(r, values.format ?? "text"));
      const under = values["fail-under"] !== undefined ? Number(values["fail-under"]) : undefined;
      if (under !== undefined && Number.isNaN(under)) throw new UsageError("--fail-under needs a number");
      if (under !== undefined && r.overall.confidence < under) {
        io.err(`exit-ramp: confidence ${r.overall.confidence} is below --fail-under ${under}`);
        return 1;
      }
      if (values["fail-on-manual"] && r.findings.some((f) => f.severity === "manual")) {
        io.err("exit-ramp: manual findings present (--fail-on-manual)");
        return 1;
      }
      return 0;
    }

    const out = resolve(io.cwd, values.out ?? "exit-ramp-out");
    const r = convert(files, options);
    r.warnings.push(...readWarnings);
    writeOut(out, r.output, values.force ?? false);
    io.out(renderText(r));
    io.out(`Wrote ${r.output.length} files to ${out}`);
    io.out(target === "workers" ? `Next: cd ${relative(io.cwd, out) || "."} && npm install && npm run typecheck && npm run dev   (read MIGRATION_REPORT.md first)` : `Next: cd ${relative(io.cwd, out) || "."} && npm install && npm start   (read MIGRATION_REPORT.md first)`);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`exit-ramp: ${e.message}`);
      return 2;
    }
    if (e instanceof ValTownApiError) {
      io.err(`exit-ramp: ${e.message}`);
      return 1;
    }
    if (e instanceof TypeError && /Unknown option|argument/i.test(e.message)) {
      io.err(`exit-ramp: ${e.message}`);
      return 2;
    }
    const msg = (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS") ? (e as Error).message : undefined;
    if (msg) {
      io.err(`exit-ramp: ${msg}`);
      return 2;
    }
    io.err(`exit-ramp: ${(e as Error).stack ?? e}`);
    return 1;
  }
}
