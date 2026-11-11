import { createServer, type IncomingMessage, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportVals, ValTownApiError } from "../src/core/exporter";
import { ROOT } from "./helpers";

// A local mock of the Val Town REST API shapes taken from the official openapi.json.
const calls: { method: string; url: string; auth?: string }[] = [];
let server: Server;
let base = "";

const VALS = [{ id: "v1", name: "alpha", privacy: "private", author: { username: "me" } }, { id: "v2", name: "beta", privacy: "public", author: { username: "me" } }];
const FILES: Record<string, { path: string; type: string; content: string }[]> = {
  v1: [
    { path: "main.http.ts", type: "http", content: "export default () => new Response('hi')" },
    { path: "tick.ts", type: "interval", content: "export default async function () {}" },
    { path: "lib", type: "directory", content: "" },
    { path: "lib/util.ts", type: "script", content: "export const x = 1" },
    { path: "../evil.ts", type: "file", content: "no" },
  ],
  v2: [{ path: "mail.ts", type: "email", content: "export default async function () {}" }],
};

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    calls.push({ method: req.method!, url: req.url!, auth: req.headers.authorization });
    const u = new URL(req.url!, "http://x");
    const send = (o: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    if (req.headers.authorization !== "Bearer good-token") return send({ message: "unauthorized" }, 401);
    if (u.pathname === "/v2/me/vals") {
      const offset = Number(u.searchParams.get("offset"));
      const page = VALS.slice(offset, offset + 1); // page size 1 to exercise pagination
      return send({ data: page, links: { self: u.href, ...(offset + 1 < VALS.length ? { next: `${base}/v2/me/vals?offset=${offset + 1}&limit=100` } : {}) } });
    }
    let m = u.pathname.match(/^\/v2\/vals\/(v\d)\/files$/);
    if (m) return send({ data: FILES[m[1]].map((f) => ({ path: f.path, name: f.path, type: f.type })), links: { self: u.href } });
    m = u.pathname.match(/^\/v2\/vals\/(v\d)\/files\/content$/);
    if (m) {
      const f = FILES[m[1]].find((x) => x.path === u.searchParams.get("path"));
      res.writeHead(f ? 200 : 404, { "content-type": "application/octet-stream" });
      return res.end(f?.content ?? "");
    }
    m = u.pathname.match(/^\/v2\/vals\/(v\d)\/environment_variables\/$/);
    if (m) return send({ data: [{ key: "B_KEY" }, { key: "A_KEY" }], links: { self: u.href } });
    m = u.pathname.match(/^\/v2\/alias\/vals\/me\/(\w+)$/);
    if (m) return send(VALS.find((v) => v.name === m![1]) ?? { message: "nf" }, VALS.some((v) => v.name === m![1]) ? 200 : 404);
    send({ message: "not found" }, 404);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("Val Town exporter (GET-only)", () => {
  it("exports every val with pagination, entrypoint kinds, env var names (sorted, no values) and skips path traversal", async () => {
    calls.length = 0;
    const out = await exportVals({ token: "good-token", baseUrl: base });
    expect(out.map((v) => v.name)).toEqual(["alpha", "beta"]);
    const a = out[0];
    expect(a.files.map((f) => f.path)).toEqual(["main.http.ts", "tick.ts", "lib/util.ts"]);
    expect(a.entrypoints).toEqual({ "main.http.ts": "http", "tick.ts": "cron" });
    expect(a.envVarNames).toEqual(["A_KEY", "B_KEY"]);
    expect(out[1].entrypoints).toEqual({ "mail.ts": "email" });
  });

  it("only ever issues GET requests, with the bearer token, to the configured host", async () => {
    calls.length = 0;
    await exportVals({ token: "good-token", baseUrl: base });
    expect(calls.length).toBeGreaterThan(5);
    expect(new Set(calls.map((c) => c.method))).toEqual(new Set(["GET"]));
    expect(calls.every((c) => c.auth === "Bearer good-token")).toBe(true);
  });

  it("the source file contains no write verbs", () => {
    const src = readFileSync(join(ROOT, "src/core/exporter.ts"), "utf8");
    expect(src).not.toMatch(/method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/i);
  });

  it("exports a single val by name", async () => {
    const out = await exportVals({ token: "good-token", baseUrl: base, val: "@me/beta" });
    expect(out.map((v) => v.name)).toEqual(["beta"]);
  });

  it("explains a rejected token", async () => {
    await expect(exportVals({ token: "bad", baseUrl: base })).rejects.toThrow(/rejected the token/);
    await expect(exportVals({ token: "bad", baseUrl: base })).rejects.toBeInstanceOf(ValTownApiError);
  });

  it("refuses to follow a pagination link to another host (token would leak)", async () => {
    const evil = async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/v2/me/vals")) return new Response(JSON.stringify({ data: [], links: { self: u, next: "https://evil.example/steal" } }), { status: 200 });
      return new Response("{}", { status: 404 });
    };
    await expect(exportVals({ token: "t", baseUrl: base, fetch: evil as typeof fetch })).rejects.toThrow(/Refusing to send the token/);
  });

  it("requires a token and a well-formed val name", async () => {
    await expect(exportVals({ token: "", baseUrl: base })).rejects.toThrow(/token/);
    await expect(exportVals({ token: "t", baseUrl: base, val: "nope" })).rejects.toThrow(/username\/valName/);
  });
});
