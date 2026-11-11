import type { Finding, ScanResult, Severity } from "./types";

const ORDER: Severity[] = ["manual", "review", "auto", "info"];
const LABEL: Record<Severity, string> = { manual: "MANUAL", review: "REVIEW", auto: "auto", info: "info" };
const MEANING: Record<Severity, string> = {
  manual: "not converted (or converted to code that throws): finish by hand",
  review: "converted, but behavior differs somewhere: read the note",
  auto: "converted, behavior should be identical",
  info: "nothing to do",
};

function esc(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function sorted(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity) || a.file.localeCompare(b.file) || a.line - b.line);
}

function totals(r: ScanResult): Record<Severity, number> {
  const t: Record<Severity, number> = { manual: 0, review: 0, auto: 0, info: 0 };
  for (const f of r.findings) t[f.severity]++;
  return t;
}

function bindingList(r: ScanResult): string[] {
  const b = r.bindings;
  const out: string[] = [];
  if (b.kv) out.push("Workers KV namespace (binding `KV`)");
  if (b.d1) out.push("D1 database (binding `DB`)");
  if (b.r2) out.push("R2 bucket (binding `BLOB`)");
  if (b.email) out.push("Email Service sender (binding `EMAIL`)");
  if (b.envVars.length) out.push(`Secrets/vars: ${b.envVars.map((v) => "`" + v + "`").join(", ")}`);
  const sched = b.cronSchedules.filter((c) => c.schedule);
  if (sched.length) out.push(`Cron triggers (UTC): ${[...new Set(sched.map((c) => "`" + c.schedule + "`"))].join(", ")}`);
  const missing = b.cronSchedules.filter((c) => !c.schedule);
  if (missing.length) out.push(`Cron jobs needing a schedule: ${missing.map((c) => "`" + c.file + "`").join(", ")}`);
  return out;
}

export function renderText(r: ScanResult): string {
  const t = totals(r);
  const L: string[] = [];
  L.push(`exit-ramp scan (target: ${r.target}, detected: ${r.detected.platform})`);
  L.push(`Overall confidence: ${r.overall.confidence}/100 (${r.overall.band})   manual ${t.manual}  review ${t.review}  auto ${t.auto}  info ${t.info}`);
  L.push("");
  const w = Math.max(4, ...r.files.map((f) => f.path.length));
  for (const f of r.files) L.push(`  ${f.path.padEnd(w)}  ${String(f.confidence).padStart(3)}  ${f.band.padEnd(6)}  ${f.kind}`);
  L.push("");
  for (const f of sorted(r.findings).filter((f) => f.severity !== "info")) L.push(`${LABEL[f.severity].padEnd(6)} ${f.file}:${f.line}  [${f.rule}] ${f.message}`);
  const bl = bindingList(r);
  if (bl.length) L.push("", "You will need:", ...bl.map((x) => "  - " + x));
  if (r.dependencies.length) L.push("", "Dependencies: " + r.dependencies.map((d) => `${d.name}@${d.range}`).join(", "));
  for (const w2 of r.warnings) L.push("", "Note: " + w2);
  return L.join("\n") + "\n";
}

export function renderMarkdown(r: ScanResult): string {
  const t = totals(r);
  const L: string[] = [];
  L.push("# exit-ramp migration report", "");
  L.push(`- Target: **${r.target}**   Detected: **${r.detected.platform}**`);
  L.push(`- Overall confidence: **${r.overall.confidence}/100 (${r.overall.band})**`);
  L.push(`- Findings: ${t.manual} manual, ${t.review} review, ${t.auto} auto, ${t.info} info`, "");
  L.push("Confidence is a triage number, not a guarantee. Each file starts at 100, loses 22 per manual finding and 8 per review finding. High is 85+, medium 60-84, low below 60. The project score is the mean, capped at the worst file + 25. Run your own tests before cutting over.", "");
  L.push("## Files", "", "| File | Kind | Confidence | Manual | Review | Auto |", "|---|---|---|---|---|---|");
  for (const f of r.files) L.push(`| \`${esc(f.path)}\` | ${f.kind} | ${f.confidence} (${f.band}) | ${f.counts.manual} | ${f.counts.review} | ${f.counts.auto} |`);
  L.push("");
  for (const sev of ORDER) {
    const list = sorted(r.findings).filter((f) => f.severity === sev);
    if (!list.length) continue;
    L.push(`## ${LABEL[sev]} (${list.length})`, "", `_${MEANING[sev]}_`, "");
    for (const f of list) L.push(`- \`${f.file}:${f.line}\` **${f.rule}**: ${f.message}${f.docs ? ` ([docs](${f.docs}))` : ""}${f.snippet ? `\n  - \`${f.snippet.replace(/`/g, "'")}\`` : ""}`);
    L.push("");
  }
  const bl = bindingList(r);
  if (bl.length) L.push("## Resources to create", "", ...bl.map((x) => "- " + x), "");
  if (r.dependencies.length) L.push("## Dependencies", "", ...r.dependencies.map((d) => `- \`${d.name}\`: \`${d.range}\``), "");
  if (r.warnings.length) L.push("## Notes", "", ...r.warnings.map((w) => "- " + w), "");
  return L.join("\n");
}

export function renderJson(r: ScanResult): string {
  const { ...rest } = r as ScanResult & { output?: unknown };
  delete (rest as { output?: unknown }).output;
  return JSON.stringify(rest, null, 2) + "\n";
}

/** Markdown for $GITHUB_STEP_SUMMARY. Compact: a table plus the manual/review items. */
export function renderGithubSummary(r: ScanResult): string {
  const t = totals(r);
  const icon = r.overall.band === "high" ? "🟢" : r.overall.band === "medium" ? "🟡" : "🔴";
  const L: string[] = [];
  L.push("## exit-ramp scan", "");
  L.push(`${icon} **Confidence ${r.overall.confidence}/100 (${r.overall.band})** · target \`${r.target}\` · detected \`${r.detected.platform}\``, "");
  L.push(`| Manual | Review | Auto | Info |`, `|---|---|---|---|`, `| ${t.manual} | ${t.review} | ${t.auto} | ${t.info} |`, "");
  if (r.files.length) {
    L.push("| File | Kind | Confidence |", "|---|---|---|");
    for (const f of r.files) L.push(`| \`${esc(f.path)}\` | ${f.kind} | ${f.confidence} (${f.band}) |`);
    L.push("");
  }
  const todo = sorted(r.findings).filter((f) => f.severity === "manual" || f.severity === "review");
  if (todo.length) {
    L.push("<details><summary>Findings to read (" + todo.length + ")</summary>", "");
    for (const f of todo.slice(0, 60)) L.push(`- **${LABEL[f.severity]}** \`${f.file}:${f.line}\` ${f.rule}: ${esc(f.message)}`);
    if (todo.length > 60) L.push(`- … and ${todo.length - 60} more (run \`exit-ramp scan\` locally).`);
    L.push("", "</details>", "");
  }
  const bl = bindingList(r);
  if (bl.length) L.push("**Resources to create:** " + bl.join("; "), "");
  return L.join("\n");
}
