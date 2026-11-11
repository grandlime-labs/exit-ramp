// exit-ramp web app. Everything runs in this tab. The core (ts-morph) is loaded on the first Scan/Convert click.
import { zipSync, strToU8 } from "fflate";
import type { ConvertResult, InputFile, ScanResult } from "../src/core/index";

type Core = typeof import("../src/core/index");
type Exporter = typeof import("../src/core/exporter");

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error("missing #" + id);
  return el as T;
};

/**
 * Convert gate. This build has NO payments: scan and convert are both open.
 * The free-scan / paid-convert split is designed in docs/PRICING-DESIGN.md. If you add a checkout later
 * (Lemon Squeezy is the intended one), verify the license here before calling convert().
 */
const CONVERT_GATE = { enabled: false as boolean, checkoutUrl: "" };

const IGNORED = /(?:^|\/)(?:node_modules|\.git|\.wrangler|dist|out|\.vscode|\.idea)(?:\/|$)/;
const MAX_FILES = 800;
const MAX_BYTES = 2 * 1024 * 1024;

let files: InputFile[] = [];
let core: Promise<Core> | undefined;
let last: { scan?: ScanResult; convert?: ConvertResult } = {};

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) el.setAttribute(k, v);
  for (const k of kids) el.append(k);
  return el;
}

function setStatus(msg: string) {
  $("status").textContent = msg;
}

/* --------------------------------- files --------------------------------- */

function addFiles(list: InputFile[]) {
  const map = new Map(files.map((f) => [f.path, f]));
  for (const f of list) map.set(f.path, f);
  files = [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
  renderFiles();
}

function renderFiles() {
  const ul = $("files");
  ul.replaceChildren();
  for (const f of files.slice(0, 200)) {
    const rm = h("button", { type: "button", "aria-label": "Remove " + f.path }, "×");
    rm.addEventListener("click", () => {
      files = files.filter((x) => x.path !== f.path);
      renderFiles();
    });
    ul.append(h("li", {}, h("span", {}, f.path), rm));
  }
  if (files.length > 200) ul.append(h("li", {}, `… and ${files.length - 200} more`));
  $("count").textContent = files.length ? `(${files.length})` : "";
  $("clear").hidden = files.length === 0;
}

function isBinary(buf: ArrayBuffer): boolean {
  return new Uint8Array(buf.slice(0, 4096)).includes(0);
}

async function readBrowserFiles(entries: { path: string; file: File }[]): Promise<{ files: InputFile[]; skipped: string[] }> {
  const out: InputFile[] = [];
  const skipped: string[] = [];
  for (const { path, file } of entries) {
    if (IGNORED.test(path)) continue;
    if (out.length >= MAX_FILES) {
      skipped.push(`${path} (file limit ${MAX_FILES})`);
      continue;
    }
    if (file.size > MAX_BYTES) {
      skipped.push(`${path} (over 2 MB)`);
      continue;
    }
    const buf = await file.arrayBuffer();
    if (isBinary(buf)) {
      skipped.push(`${path} (binary)`);
      continue;
    }
    out.push({ path, text: new TextDecoder().decode(buf) });
  }
  return { files: out, skipped };
}

async function walkEntry(entry: FileSystemEntry, prefix: string, acc: { path: string; file: File }[]): Promise<void> {
  if (IGNORED.test(prefix + entry.name)) return;
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    acc.push({ path: prefix + entry.name, file });
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) await walkEntry(e, prefix + entry.name + "/", acc);
    }
  }
}

async function ingest(entries: { path: string; file: File }[]) {
  setStatus("Reading files…");
  const r = await readBrowserFiles(entries);
  addFiles(r.files);
  setStatus(`Added ${r.files.length} file(s).${r.skipped.length ? " Skipped: " + r.skipped.slice(0, 5).join(", ") + (r.skipped.length > 5 ? ", …" : "") : ""}`);
}

/* ---------------------------------- tabs ---------------------------------- */

for (const name of ["paste", "folder", "vt"] as const) {
  $("tab-" + name).addEventListener("click", () => {
    for (const n of ["paste", "folder", "vt"]) {
      $("tab-" + n).setAttribute("aria-selected", String(n === name));
      $("pane-" + n).hidden = n !== name;
    }
  });
}

$("paste-add").addEventListener("click", () => {
  const name = $<HTMLInputElement>("paste-name").value.trim().replace(/^\/+/, "");
  const code = $<HTMLTextAreaElement>("paste-code").value;
  if (!name || !code.trim()) return setStatus("Enter a file name and some code first.");
  addFiles([{ path: name, text: code }]);
  $<HTMLTextAreaElement>("paste-code").value = "";
  setStatus(`Added ${name}.`);
});

const SAMPLE = `const kv = await Deno.openKv();
const greeting = Deno.env.get("GREETING") ?? "hello";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const key = ["hits", url.pathname];
  const cur = await kv.get<number>(key);
  await kv.set(key, (cur.value ?? 0) + 1);
  return new Response(\`\${greeting} \${url.pathname} (\${(cur.value ?? 0) + 1})\`);
});

Deno.cron("cleanup", "0 3 * * 1-5", async () => {
  for await (const e of kv.list({ prefix: ["hits"] })) await kv.delete(e.key);
});
`;
$("paste-sample").addEventListener("click", () => {
  $<HTMLInputElement>("paste-name").value = "main.ts";
  $<HTMLTextAreaElement>("paste-code").value = SAMPLE;
});

const folderInput = $<HTMLInputElement>("folder-input");
folderInput.addEventListener("change", async () => {
  const list = [...(folderInput.files ?? [])].map((f) => ({ path: (f as File & { webkitRelativePath: string }).webkitRelativePath || f.name, file: f }));
  await ingest(list);
  folderInput.value = "";
});
const drop = $("drop");
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", async (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  const items = [...(e.dataTransfer?.items ?? [])];
  const acc: { path: string; file: File }[] = [];
  // webkitGetAsEntry must be called synchronously for every item before awaiting anything
  const entries = items.map((i) => i.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => !!x);
  for (const en of entries) await walkEntry(en, "", acc);
  if (!entries.length) for (const f of e.dataTransfer?.files ?? []) acc.push({ path: f.name, file: f });
  await ingest(acc);
});
$("clear").addEventListener("click", () => {
  files = [];
  renderFiles();
  $("results").hidden = true;
});

/* ----------------------------- Val Town exporter ----------------------------- */

$("vt-go").addEventListener("click", async () => {
  const tokenEl = $<HTMLInputElement>("vt-token");
  const status = $("vt-status");
  status.textContent = "Contacting api.val.town…";
  try {
    const { exportVals }: Exporter = await import("../src/core/exporter");
    const vals = await exportVals({ token: tokenEl.value.trim(), val: $<HTMLInputElement>("vt-val").value.trim() || undefined, onProgress: (m) => (status.textContent = m) });
    const single = vals.length === 1;
    const crons: string[] = [];
    for (const v of vals) {
      addFiles(v.files.map((f) => ({ path: single ? f.path : `${v.name}/${f.path}`, text: f.text })));
      for (const [p, k] of Object.entries(v.entrypoints)) if (k === "cron") crons.push(`${single ? p : v.name + "/" + p}=`);
    }
    const cur = $<HTMLTextAreaElement>("crons");
    if (crons.length) cur.value = (cur.value ? cur.value + "\n" : "") + crons.map((c) => c + "<cron expression>").join("\n");
    status.textContent = `Downloaded ${vals.reduce((n, v) => n + v.files.length, 0)} file(s) from ${vals.length} val(s). ${crons.length ? "Fill in the cron schedules below: the API does not expose them." : ""}`;
    tokenEl.value = "";
  } catch (e) {
    status.textContent = (e as Error).message;
  }
});

/* ---------------------------------- scan ---------------------------------- */

function options() {
  const crons: Record<string, string> = {};
  for (const line of $<HTMLTextAreaElement>("crons").value.split("\n")) {
    const i = line.indexOf("=");
    const expr = line.slice(i + 1).trim();
    if (i > 0 && expr && !expr.startsWith("<")) crons[line.slice(0, i).trim()] = expr;
  }
  return { target: $<HTMLSelectElement>("target").value as "workers" | "node", crons, projectName: $<HTMLInputElement>("name").value || "my-app" };
}

function loadCore(): Promise<Core> {
  core ??= import("../src/core/index");
  return core;
}

async function busy<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  const buttons = [$("scan"), $("convert")] as HTMLButtonElement[];
  buttons.forEach((b) => (b.disabled = true));
  setStatus(label);
  // let the browser paint the status before the CPU-heavy work starts
  await new Promise((r) => setTimeout(r, 30));
  try {
    return await fn();
  } catch (e) {
    setStatus("Failed: " + (e as Error).message);
    return undefined;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

$("scan").addEventListener("click", () => {
  if (!files.length) return setStatus("Add some code first.");
  void busy("Loading the analyzer (first run only) and scanning…", async () => {
    const c = await loadCore();
    const t0 = performance.now();
    const r = c.scan(files, options());
    last = { scan: r };
    render(r);
    setStatus(`Scanned ${r.files.length} file(s) in ${Math.round(performance.now() - t0)} ms. Nothing left this tab.`);
  });
});

$("convert").addEventListener("click", () => {
  if (!files.length) return setStatus("Add some code first.");
  if (CONVERT_GATE.enabled) return setStatus("Convert needs a license: " + CONVERT_GATE.checkoutUrl);
  void busy("Converting…", async () => {
    const c = await loadCore();
    const r = c.convert(files, options());
    last = { scan: r, convert: r };
    render(r);
    const zip: Record<string, Uint8Array> = {};
    for (const f of r.output) zip[f.path] = strToU8(f.content);
    const blob = new Blob([zipSync(zip) as BlobPart], { type: "application/zip" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `${options().projectName}-workers.zip` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    setStatus(`Built ${r.output.length} files. Read MIGRATION_REPORT.md first, then: npm install && npm run typecheck && npm run dev.`);
  });
});

/* -------------------------------- rendering -------------------------------- */

const LABEL = { manual: "MANUAL", review: "REVIEW", auto: "AUTO", info: "INFO" } as const;

function render(r: ScanResult) {
  $("results").hidden = false;
  const s = $("summary");
  const t = { manual: 0, review: 0, auto: 0, info: 0 };
  for (const f of r.findings) t[f.severity]++;
  s.replaceChildren(
    h("div", { class: `score band-${r.overall.band}` }, `${r.overall.confidence}/100`),
    h("p", {}, `${r.overall.band} confidence · target ${r.target} · detected ${r.detected.platform} · ${t.manual} manual, ${t.review} review, ${t.auto} auto`),
  );
  const tb = $("filetable").querySelector("tbody")!;
  tb.replaceChildren(...r.files.map((f) => h("tr", {}, h("td", {}, f.path), h("td", {}, f.kind), h("td", { class: `band-${f.band}` }, `${f.confidence} (${f.band})`), h("td", {}, String(f.counts.manual)), h("td", {}, String(f.counts.review)))));
  renderFindings(r);
  const need: string[] = [];
  if (r.bindings.kv) need.push("Workers KV namespace (KV)");
  if (r.bindings.d1) need.push("D1 database (DB)");
  if (r.bindings.r2) need.push("R2 bucket (BLOB)");
  if (r.bindings.email) need.push("Email Service sender (EMAIL)");
  if (r.bindings.envVars.length) need.push("Secrets: " + r.bindings.envVars.join(", "));
  const known = [...new Set(r.bindings.cronSchedules.filter((c) => c.schedule).map((c) => c.schedule!))];
  if (known.length) need.push("Cron triggers (UTC): " + known.join(", "));
  const n = $("needs");
  n.replaceChildren();
  if (need.length) n.append(h("h3", {}, "You will need"), h("ul", {}, ...need.map((x) => h("li", {}, x))));
  if (r.warnings.length) n.append(h("h3", {}, "Notes"), h("ul", {}, ...r.warnings.map((x) => h("li", {}, x))));
}

function renderFindings(r: ScanResult) {
  const showAll = $<HTMLInputElement>("f-info").checked;
  const order = ["manual", "review", "auto", "info"];
  const list = [...r.findings].filter((f) => showAll || f.severity === "manual" || f.severity === "review").sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity) || a.file.localeCompare(b.file) || a.line - b.line);
  $("findings").replaceChildren(
    ...list.map((f) => {
      const li = h("li", { class: `sev-${f.severity}` }, h("span", { class: "badge" }, LABEL[f.severity]), h("span", { class: "where" }, `${f.file}:${f.line} [${f.rule}]`), h("div", {}, f.message));
      if (f.snippet) li.append(h("code", {}, f.snippet));
      if (f.docs && f.docs.startsWith("https://")) li.append(h("a", { href: f.docs, rel: "noopener noreferrer", target: "_blank" }, "docs"));
      return li;
    }),
  );
  if (!list.length) $("findings").append(h("li", {}, "Nothing needs attention."));
}
$("f-info").addEventListener("change", () => last.scan && renderFindings(last.scan));

$("dates").textContent = "Val Town: code goes read-only 2026-12-10 (sqlite and blob storage are excluded and run until 2027-01-10), and everything else stops on 2027-01-10. Deno Deploy shuts down about six months after the 2026-10-09 Cloudflare announcement.";
renderFiles();
