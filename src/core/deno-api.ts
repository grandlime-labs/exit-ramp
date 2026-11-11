import type { Severity } from "./types";

export interface Advice {
  severity: Severity;
  message: string;
}

const NO_FS = "Workers has no persistent filesystem. Import the file as text/JSON at build time, bundle it, or keep the data in R2/D1/KV (node:fs only sees files bundled into the Worker, with nodejs_compat).";

/** What to do about each Deno.* API that exit-ramp does not rewrite automatically. */
export const DENO_ADVICE: Record<string, Advice> = {
  readFile: { severity: "manual", message: NO_FS },
  readFileSync: { severity: "manual", message: NO_FS },
  readTextFile: { severity: "manual", message: NO_FS },
  readTextFileSync: { severity: "manual", message: NO_FS },
  readDir: { severity: "manual", message: NO_FS },
  readDirSync: { severity: "manual", message: NO_FS },
  stat: { severity: "manual", message: NO_FS },
  writeFile: { severity: "manual", message: "Workers cannot write to disk. Persist with R2, D1 or KV (/tmp is per-request scratch only)." },
  writeFileSync: { severity: "manual", message: "Workers cannot write to disk. Persist with R2, D1 or KV." },
  writeTextFile: { severity: "manual", message: "Workers cannot write to disk. Persist with R2, D1 or KV." },
  writeTextFileSync: { severity: "manual", message: "Workers cannot write to disk. Persist with R2, D1 or KV." },
  mkdir: { severity: "manual", message: "Workers has no persistent filesystem; use R2 key prefixes instead of directories." },
  remove: { severity: "manual", message: "Workers has no persistent filesystem; delete from R2/D1/KV instead." },
  rename: { severity: "manual", message: "Workers has no persistent filesystem." },
  makeTempFile: { severity: "manual", message: "Use an in-memory buffer or R2; /tmp exists but is temporary." },
  open: { severity: "manual", message: NO_FS },
  exit: { severity: "manual", message: "A Worker cannot exit. Return a Response or throw instead." },
  args: { severity: "manual", message: "Workers has no argv. Pass configuration through bindings or request data." },
  cwd: { severity: "manual", message: "Workers has no working directory." },
  Command: { severity: "manual", message: "Workers cannot spawn subprocesses. Use a Container, or rewrite the logic in JavaScript." },
  listen: { severity: "manual", message: "Workers cannot open listening sockets. Handle requests in fetch(); use cloudflare:sockets connect() for outbound TCP." },
  listenTls: { severity: "manual", message: "Workers terminates TLS for you. Handle requests in fetch()." },
  connect: { severity: "manual", message: "Use connect() from cloudflare:sockets for outbound TCP." },
  upgradeWebSocket: { severity: "manual", message: "Use WebSocketPair in a Worker (or a Durable Object for shared state): https://developers.cloudflare.com/workers/runtime-apis/websockets/" },
  addSignalListener: { severity: "manual", message: "Workers has no OS signals." },
  hostname: { severity: "manual", message: "Not available in Workers." },
  memoryUsage: { severity: "manual", message: "Not available in Workers." },
  env: { severity: "manual", message: "Only Deno.env.get/has/toObject are rewritten. Deno.env.set/delete cannot work: Worker bindings are read-only." },
  stdout: { severity: "manual", message: "Use console.log." },
  stderr: { severity: "manual", message: "Use console.error." },
  stdin: { severity: "manual", message: "Workers has no stdin." },
  errors: { severity: "manual", message: "Deno.errors classes do not exist; check error.name / status codes instead." },
  permissions: { severity: "manual", message: "Workers has no permission prompts." },
  version: { severity: "review", message: "Not available in Workers. Remove it, or read navigator.userAgent." },
  inspect: { severity: "review", message: "Use inspect from node:util (needs nodejs_compat)." },
  noColor: { severity: "review", message: "Not available in Workers; drop it." },
  build: { severity: "review", message: "Not available in Workers; drop it." },
  mainModule: { severity: "manual", message: "Not available in Workers (and import.meta.main does not exist either)." },
  test: { severity: "info", message: "Deno.test is only for the Deno test runner. Port these tests to vitest (or @cloudflare/vitest-pool-workers)." },
  Kv: { severity: "manual", message: "Deno.Kv type with no matching adapter export." },
};

export function adviceFor(member: string): Advice {
  return DENO_ADVICE[member] ?? { severity: "manual", message: `Deno.${member} has no automatic Workers mapping. Find the Web or Node (nodejs_compat) equivalent, or move the logic out of the Worker.` };
}

/** Type names under `Deno.` that the KV helper re-exports with the same shape. */
export const KV_TYPE_MAP: Record<string, string> = {
  Kv: "Kv",
  KvKey: "KvKey",
  KvKeyPart: "KvKeyPart",
  KvEntry: "KvEntry",
  KvEntryMaybe: "KvEntryMaybe",
  KvListSelector: "KvListSelector",
  KvListOptions: "KvListOptions",
  KvListIterator: "KvListIterator",
  KvCommitResult: "KvCommitResult",
  KvCommitError: "KvCommitError",
  AtomicOperation: "AtomicOperation",
  AtomicCheck: "KvCheck",
};
