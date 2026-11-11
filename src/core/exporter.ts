/**
 * Optional Val Town exporter. READ-ONLY by construction: every request is a GET, and the only write-capable
 * HTTP verb never appears in this file (tests assert it). Docs: https://docs.val.town/api/ (REST v2).
 *
 * Auth: a Val Town API token with read scopes (vals + files). Pass it in (the web app keeps it in memory only; the CLI
 * reads the VAL_TOWN_API_KEY environment variable). The token is sent only to `baseUrl` (default https://api.val.town).
 *
 * Not available through the API: cron schedules (set them with --cron / exit-ramp.config.json) and environment
 * variable VALUES (only the names are listed, so you must re-enter secrets yourself).
 */
import type { InputFile } from "./types";

export const VAL_TOWN_API = "https://api.val.town";

export interface ExportOptions {
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** "username/valName" (with or without a leading @). Omit to export all of your vals. */
  val?: string;
  onProgress?: (msg: string) => void;
  /** Safety valve for pagination loops. */
  maxPages?: number;
}

export interface ExportedVal {
  id: string;
  name: string;
  author: string | null;
  privacy: string;
  files: InputFile[];
  /** File path -> kind, from Val Town's file types (interval = cron). */
  entrypoints: Record<string, "http" | "cron" | "email">;
  envVarNames: string[];
}

interface Page<T> {
  data: T[];
  links: { next?: string };
}

interface ValJson {
  id: string;
  name: string;
  privacy: string;
  author: { username: string | null };
}

interface FileMeta {
  path: string;
  type: "directory" | "file" | "interval" | "http" | "email" | "script";
}

export class ValTownApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ValTownApiError";
  }
}

function safePath(p: string): string | undefined {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length || parts.some((x) => x === "..")) return undefined;
  return parts.join("/");
}

export async function exportVals(opts: ExportOptions): Promise<ExportedVal[]> {
  if (!opts.token) throw new Error("A Val Town API token is required (VAL_TOWN_API_KEY).");
  const base = (opts.baseUrl ?? VAL_TOWN_API).replace(/\/$/, "");
  const doFetch = opts.fetch ?? fetch;
  const log = opts.onProgress ?? (() => {});
  const maxPages = opts.maxPages ?? 200;

  const get = async (urlOrPath: string, accept = "application/json"): Promise<Response> => {
    const url = urlOrPath.startsWith("http") ? urlOrPath : base + urlOrPath;
    if (!url.startsWith(base + "/")) throw new Error(`Refusing to send the token to ${url}`);
    const res = await doFetch(url, { method: "GET", headers: { Authorization: `Bearer ${opts.token}`, Accept: accept } });
    if (res.status === 401) throw new ValTownApiError(401, "Val Town rejected the token (401). Create one with read access at https://www.val.town/settings/api");
    if (res.status === 403) throw new ValTownApiError(403, "The token lacks permission for this resource (403). It needs read access to vals and files.");
    if (res.status === 429) throw new ValTownApiError(429, "Val Town rate limit (429). Wait a minute and retry.");
    if (!res.ok) throw new ValTownApiError(res.status, `Val Town API ${res.status} for ${url.replace(base, "")}`);
    return res;
  };

  const paged = async <T>(path: string): Promise<T[]> => {
    const out: T[] = [];
    let next: string | undefined = path;
    for (let i = 0; next && i < maxPages; i++) {
      const page = (await (await get(next)).json()) as Page<T>;
      out.push(...page.data);
      next = page.links?.next;
    }
    return out;
  };

  let vals: ValJson[];
  if (opts.val) {
    const m = opts.val.replace(/^@/, "").split("/");
    if (m.length !== 2 || !m[0] || !m[1]) throw new Error('Val must look like "username/valName".');
    vals = [(await (await get(`/v2/alias/vals/${encodeURIComponent(m[0])}/${encodeURIComponent(m[1])}`)).json()) as ValJson];
  } else {
    vals = await paged<ValJson>("/v2/me/vals?offset=0&limit=100");
  }
  log(`${vals.length} val(s)`);

  const out: ExportedVal[] = [];
  for (const v of vals) {
    log(`listing ${v.name}`);
    const metas = await paged<FileMeta>(`/v2/vals/${v.id}/files?path=${encodeURIComponent("")}&recursive=true&offset=0&limit=100`);
    const files: InputFile[] = [];
    const entrypoints: ExportedVal["entrypoints"] = {};
    for (const m of metas) {
      if (m.type === "directory") continue;
      const path = safePath(m.path);
      if (!path) continue;
      const res = await get(`/v2/vals/${v.id}/files/content?path=${encodeURIComponent(m.path)}`, "*/*");
      files.push({ path, text: await res.text() });
      if (m.type === "http") entrypoints[path] = "http";
      else if (m.type === "interval") entrypoints[path] = "cron";
      else if (m.type === "email") entrypoints[path] = "email";
    }
    let envVarNames: string[] = [];
    try {
      const envs = await paged<{ key: string }>(`/v2/vals/${v.id}/environment_variables/?offset=0&limit=100`);
      envVarNames = envs.map((e) => e.key).sort();
    } catch (e) {
      if (!(e instanceof ValTownApiError) || e.status !== 403) throw e;
      log("token cannot list environment variable names; skipping");
    }
    out.push({ id: v.id, name: v.name, author: v.author?.username ?? null, privacy: v.privacy, files, entrypoints, envVarNames });
  }
  return out;
}
