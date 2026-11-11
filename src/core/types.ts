/** Shared types. Input is always a list of files; nothing touches the disk or network in core. */

export type Target = "workers" | "node";

export interface InputFile {
  /** Posix-style path relative to the project root, e.g. "main.http.tsx". */
  path: string;
  text: string;
}

/**
 * auto    rewritten, behavior should be identical
 * review  rewritten, but semantics differ somewhere: a human must read the note
 * manual  not converted (or converted to something that throws): a human must finish it
 * info    nothing to do, worth knowing
 */
export type Severity = "auto" | "review" | "manual" | "info";

export type FileKind = "http" | "cron" | "email" | "module" | "asset";

export interface Finding {
  rule: string;
  file: string;
  line: number;
  column: number;
  severity: Severity;
  message: string;
  snippet?: string;
  /** Link to the doc that backs the mapping. */
  docs?: string;
}

export type Band = "high" | "medium" | "low";

export interface FileReport {
  path: string;
  outPath: string;
  kind: FileKind;
  /** 0-100. See scoreFindings(). */
  confidence: number;
  band: Band;
  counts: Record<Severity, number>;
  rewritten: boolean;
}

export interface Dependency {
  name: string;
  range: string;
}

export interface ScanOptions {
  target?: Target;
  /** Treat these paths as the given val type when the file name does not say. */
  entrypoints?: Record<string, "http" | "cron" | "email">;
  /** Cron expressions for Val Town interval vals (the schedule is not in the source). Keyed by file path. */
  crons?: Record<string, string>;
}

export interface ConvertOptions extends ScanOptions {
  projectName?: string;
  /** wrangler compatibility_date. Must not be later than the installed workerd supports. */
  compatibilityDate?: string;
}

export interface Bindings {
  kv: boolean;
  d1: boolean;
  r2: boolean;
  email: boolean;
  /** secrets / vars referenced through Deno.env */
  envVars: string[];
  emailIn: boolean;
  lastRun: boolean;
  nodejsCompat: boolean;
  jsr: boolean;
  cronSchedules: { file: string; schedule: string | undefined }[];
  /** Val Town's ambient `Interval` / `Email` types are used and need a global declaration. */
  valtownTypes: { interval: boolean; email: boolean };
}

export interface ScanResult {
  target: Target;
  files: FileReport[];
  findings: Finding[];
  dependencies: Dependency[];
  bindings: Bindings;
  /** Weighted by file: lowest score wins ties; see overallConfidence(). */
  overall: { confidence: number; band: Band };
  detected: { platform: "val-town" | "deno-deploy" | "mixed" | "unknown"; entrypoints: { file: string; kind: FileKind }[] };
  warnings: string[];
}

export interface OutputFile {
  path: string;
  content: string;
}

export interface ConvertResult extends ScanResult {
  output: OutputFile[];
}
