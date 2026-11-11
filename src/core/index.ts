import { analyzeFile, applyEdits, CODE_EXT, newProject, type FileAnalysis } from "./analyze";
import { readImportMap } from "./imports";
import { bandOf, countBySeverity, overallConfidence, scoreFindings } from "./score";
import { DEFAULT_COMPAT_DATE, scaffold, slugify, type ScaffoldInput } from "./scaffold";
import type { Bindings, ConvertOptions, ConvertResult, Dependency, FileReport, Finding, InputFile, OutputFile, ScanOptions, ScanResult } from "./types";

export * from "./types";
import { renderJson, renderMarkdown } from "./report";
export { renderGithubSummary, renderJson, renderMarkdown, renderText } from "./report";
export { unixCronToCloudflare, denoScheduleToUnix } from "./cron";
export { DEFAULT_COMPAT_DATE } from "./scaffold";

const IGNORED = /(?:^|\/)(?:node_modules|\.git|\.wrangler|dist|out|\.vscode|\.idea)(?:\/|$)|(?:^|\/)(?:deno\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.DS_Store)$/;
const CONFIG_FILES = /(?:^|\/)(?:deno\.jsonc?|import_map\.json|exit-ramp\.config\.json)$/;

/** Normalize separators, drop ignored paths, and strip a shared top-level folder (dropped folders arrive as "myproject/..."). */
export function normalizeFiles(files: InputFile[]): InputFile[] {
  let list = files.map((f) => ({ path: f.path.replace(/\\/g, "/").replace(/^\.?\/+/, ""), text: f.text })).filter((f) => f.path && !IGNORED.test(f.path));
  if (list.length > 1 || (list.length === 1 && list[0].path.includes("/"))) {
    const first = list[0]?.path.split("/")[0];
    if (first && list.every((f) => f.path.includes("/") && f.path.split("/")[0] === first)) list = list.map((f) => ({ path: f.path.slice(first.length + 1), text: f.text }));
  }
  const seen = new Set<string>();
  return list.filter((f) => (seen.has(f.path) ? false : (seen.add(f.path), true)));
}

interface Run {
  options: Required<Pick<ScanOptions, "target">> & ScanOptions;
  analyses: FileAnalysis[];
  assets: InputFile[];
  texts: Map<string, string>;
  result: ScanResult;
}

function mergeDeps(list: Dependency[], warnings: string[]): Dependency[] {
  const m = new Map<string, Dependency>();
  for (const d of list) {
    const cur = m.get(d.name);
    if (!cur) m.set(d.name, d);
    else if (cur.range !== d.range && d.range !== "latest") {
      if (cur.range === "latest") m.set(d.name, d);
      else warnings.push(`${d.name} is imported with different versions (${cur.range}, ${d.range}); package.json uses ${cur.range}.`);
    }
  }
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function run(rawFiles: InputFile[], opts: ConvertOptions = {}): Run {
  const target = opts.target ?? "workers";
  const files = normalizeFiles(rawFiles);
  const importMap = readImportMap(files);
  const project = newProject();
  const warnings: string[] = [];
  const analyses: FileAnalysis[] = [];
  const assets: InputFile[] = [];
  const texts = new Map<string, string>();
  const ctx = { target, importMap, options: opts };

  for (const f of files) {
    if (CONFIG_FILES.test(f.path)) continue;
    if (CODE_EXT.test(f.path) && !/\.d\.[cm]?ts$/.test(f.path)) {
      let a: FileAnalysis;
      try {
        a = analyzeFile(project, f.path, f.text, ctx);
      } catch (e) {
        warnings.push(`${f.path}: could not be analyzed (${(e as Error).message}). It is copied unchanged.`);
        assets.push(f);
        continue;
      }
      analyses.push(a);
      texts.set(f.path, f.text);
    } else {
      assets.push(f);
    }
  }
  analyses.sort((x, y) => x.path.localeCompare(y.path));

  const findings: Finding[] = analyses.flatMap((a) => a.findings);
  const reports: FileReport[] = analyses.map((a) => {
    const c = scoreFindings(a.findings);
    return { path: a.path, outPath: a.outPath, kind: a.kind, confidence: c, band: bandOf(c), counts: countBySeverity(a.findings), rewritten: a.rewritten };
  });

  const deps: Dependency[] = analyses.flatMap((a) => a.deps);
  const workers = target === "workers";
  const hasEmailEntry = workers && analyses.some((a) => a.entry?.type === "email");
  const crons: Bindings["cronSchedules"] = [];
  for (const a of analyses) {
    if (a.entry?.type === "cron" && target === "workers") crons.push({ file: a.path, schedule: a.valCronSchedule });
    if (a.entry?.type === "cron" && target === "node") crons.push({ file: a.path, schedule: a.valCronSchedule });
    for (const c of a.denoCrons) crons.push({ file: `${a.path}#${c.exportName}`, schedule: c.schedule });
  }
  const lastRun = workers && analyses.some((a) => a.entry?.type === "cron" && a.entry.lastRunAt);
  const jsr = analyses.some((a) => a.jsr) || deps.some((d) => d.range.startsWith("npm:@jsr/"));
  if (hasEmailEntry) deps.push({ name: "postal-mime", range: "^4" });
  if (!workers && crons.length) deps.push({ name: "croner", range: "^9" });
  const bindings: Bindings = {
    kv: analyses.some((a) => a.usesKv) || lastRun,
    d1: analyses.some((a) => a.usesD1),
    r2: analyses.some((a) => a.usesR2),
    email: analyses.some((a) => a.usesEmail),
    envVars: [...new Set(analyses.flatMap((a) => [...a.env]))].sort(),
    emailIn: hasEmailEntry,
    lastRun,
    nodejsCompat: true,
    jsr,
    cronSchedules: crons,
    valtownTypes: { interval: analyses.some((a) => a.valtownTypes.interval || (a.entry?.type === "cron" && a.entry.lastRunAt)), email: analyses.some((a) => a.valtownTypes.email || a.entry?.type === "email") && workers },
  };

  const vt = analyses.some((a) => a.findings.some((f) => /^(?:import-valtown|import-esm-town|val-|valtown-)/.test(f.rule)) || /\.(?:http|cron|interval|email)\.[cm]?[jt]sx?$/.test(a.path));
  const dn = analyses.some((a) => a.denoServe || a.denoCrons.length || a.usesKv);
  const platform = vt && dn ? "mixed" : vt ? "val-town" : dn ? "deno-deploy" : "unknown";
  if (platform === "unknown" && analyses.length) warnings.push("No Val Town or Deno Deploy patterns were found. The files are copied as modules; nothing is wired as an entry point unless you pass --entry.");
  if (!analyses.length) warnings.push("No JavaScript or TypeScript files were found.");
  if (assets.length) warnings.push(`${assets.length} non-code file(s) are copied unchanged: ${assets.slice(0, 5).map((a) => a.path).join(", ")}${assets.length > 5 ? ", …" : ""}. Serve static files through Workers Static Assets.`);

  const merged = mergeDeps(deps, warnings);
  const result: ScanResult = {
    target,
    files: reports,
    findings,
    dependencies: merged,
    bindings,
    overall: { confidence: overallConfidence(reports.map((r) => r.confidence)), band: bandOf(overallConfidence(reports.map((r) => r.confidence))) },
    detected: { platform, entrypoints: analyses.filter((a) => a.kind !== "module" || a.denoServe || a.denoCrons.length).map((a) => ({ file: a.path, kind: a.kind })) },
    warnings,
  };
  return { options: { ...opts, target }, analyses, assets, texts, result };
}

/** Analyze only. Never produces output files. */
export function scan(files: InputFile[], options: ScanOptions = {}): ScanResult {
  return run(files, options).result;
}

/** Analyze and rewrite. Returns the generated project as in-memory files. */
export function convert(files: InputFile[], options: ConvertOptions = {}): ConvertResult {
  const r = run(files, options);
  const out: OutputFile[] = [];
  const warnings = r.result.warnings;
  for (const a of r.analyses) {
    const { text, dropped } = applyEdits(r.texts.get(a.path)!, a.edits);
    if (dropped.length) warnings.push(`${a.path}: ${dropped.length} edit(s) overlapped and were skipped; review that file by hand.`);
    out.push({ path: a.outPath, content: text });
  }
  for (const f of r.assets) out.push({ path: "src/" + f.path, content: f.text });
  const input: ScaffoldInput = {
    target: r.result.target,
    projectName: slugify(options.projectName ?? "exit-ramp-app"),
    compatibilityDate: options.compatibilityDate ?? DEFAULT_COMPAT_DATE,
    analyses: r.analyses,
    dependencies: r.result.dependencies,
    bindings: r.result.bindings,
    warnings,
  };
  const sc = scaffold(input);
  warnings.push(...sc.warnings);
  out.push(...sc.files);
  const result = { ...r.result, warnings, output: out };
  // the report file is generated last so it lists every warning
  return withReport(result);
}

function withReport(result: ConvertResult): ConvertResult {
  const output = [...result.output, { path: "MIGRATION_REPORT.md", content: renderMarkdown(result) }, { path: "exit-ramp-report.json", content: renderJson(result) }];
  return { ...result, output };
}
