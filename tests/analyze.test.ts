import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { convert, convertOne, files, fixture, scan } from "./helpers";

/** Every converted file must still be syntactically valid TypeScript/TSX. */
function assertParses(path: string, code: string) {
  const loader = path.endsWith("x") ? "tsx" : "ts";
  expect(() => transformSync(code, { loader, logLevel: "silent" }), `${path} should parse:\n${code}`).not.toThrow();
}

const sev = (r: { findings: { rule: string; severity: string }[] }, rule: string) => r.findings.filter((f) => f.rule === rule).map((f) => f.severity);

describe("Deno.serve", () => {
  it("rewrites (handler) and (options, handler) into an exported handler", () => {
    for (const src of [`Deno.serve((req) => new Response("a"));`, `Deno.serve({ port: 8080 }, async (req) => new Response("a"));`, `Deno.serve({ handler: (req) => new Response("a") });`]) {
      const { out, r } = convertOne("main.ts", src);
      expect(out).toMatch(/^export const exitRampFetch = /m);
      expect(out).not.toContain("Deno.serve");
      assertParses("main.ts", out);
      expect(r.detected.entrypoints).toEqual([{ file: "main.ts", kind: "http" }]);
    }
  });
  it("is 'review' when options or the second handler argument are used, 'auto' otherwise", () => {
    expect(sev(convertOne("a.ts", `Deno.serve((req) => new Response("a"));`).r, "deno-serve")).toEqual(["auto"]);
    expect(sev(convertOne("a.ts", `Deno.serve({ port: 1 }, (req) => new Response("a"));`).r, "deno-serve")).toEqual(["review"]);
    expect(sev(convertOne("a.ts", `Deno.serve((req, info) => new Response(info.remoteAddr.hostname));`).r, "deno-serve")).toEqual(["review"]);
  });
  it("flags Deno.serve that is not a top-level statement", () => {
    const { r, out } = convertOne("a.ts", `function start() { Deno.serve(() => new Response("x")); }`);
    expect(sev(r, "deno-serve")).toEqual(["manual"]);
    expect(out).toContain("TODO(exit-ramp:deno-serve)");
  });
  it("wires the handler in worker.ts", () => {
    const { get } = convertOne("main.ts", `Deno.serve((req) => new Response("a"));`);
    const w = get("src/worker.ts")!;
    expect(w).toContain("exitRampFetch");
    expect(w).toContain("cf-connecting-ip");
    assertParses("worker.ts", w);
  });
});

describe("Deno.cron", () => {
  it("rewrites to an exported job and registers the trigger", () => {
    const { out, r, get } = convertOne("jobs.ts", `Deno.cron("tick", "*/5 * * * *", () => { console.log(1); });`);
    expect(out).toContain(`export const exitRampCron_1 = { name: "tick", schedule: "*/5 * * * *", run: () => { console.log(1); } }`);
    assertParses("jobs.ts", out);
    expect(get("wrangler.toml")).toContain('crons = ["*/5 * * * *"]');
    expect(r.bindings.cronSchedules).toEqual([{ file: "jobs.ts#exitRampCron_1", schedule: "*/5 * * * *" }]);
    expect(sev(r, "deno-cron")).toEqual(["auto"]);
  });
  it("converts numeric weekdays to names (Cloudflare counts 1=Sunday)", () => {
    const { out, get } = convertOne("jobs.ts", `Deno.cron("w", "0 9 * * 1-5", () => {});`);
    expect(out).toContain('schedule: "0 9 * * MON-FRI"');
    expect(get("wrangler.toml")).toContain('"0 9 * * MON-FRI"');
  });
  it("converts object schedules and flags backoffSchedule", () => {
    const { out, r } = convertOne("jobs.ts", `Deno.cron("x", { minute: { every: 20 } }, { backoffSchedule: [1000] }, () => {});`);
    expect(out).toContain('schedule: "*/20 * * * *"');
    expect(r.findings.find((f) => f.rule === "deno-cron")?.message).toMatch(/backoffSchedule/);
    assertParses("jobs.ts", out);
  });
  it("marks computed schedules manual and writes no trigger", () => {
    const { r, get } = convertOne("jobs.ts", `const s = "* * * * *"; Deno.cron("x", s, () => {});`);
    expect(sev(r, "deno-cron")).toEqual(["manual"]);
    expect(get("wrangler.toml")).toContain("TODO(exit-ramp)");
    expect(get("wrangler.toml")).toContain("crons = []");
  });
  it("wires jobs by the cron expression that fired", () => {
    const w = convert(files({ "a.ts": `Deno.cron("a", "0 1 * * *", () => {}); Deno.cron("b", "0 2 * * *", () => {});` })).output.find((f) => f.path === "src/worker.ts")!.content;
    expect(w).toContain("j.schedule === controller.cron");
    expect(w).toContain("m0.exitRampCron_1");
    expect(w).toContain("m0.exitRampCron_2");
    assertParses("worker.ts", w);
  });
});

describe("Deno.env", () => {
  it("rewrites get/has/toObject to the Workers env and declares the variable", () => {
    const { out, r, get } = convertOne("a.ts", `const a = Deno.env.get("FOO"); const b = Deno.env.has("BAR"); const c = Deno.env.toObject(); export { a, b, c };`);
    expect(out).toContain(`import { env } from "cloudflare:workers";`);
    expect(out).toContain("env.FOO");
    expect(out).toContain(`("BAR" in env)`);
    expect(out).toContain("Object.fromEntries(Object.entries(env)");
    expect(r.bindings.envVars).toEqual(["BAR", "FOO"]);
    expect(get(".dev.vars.example")).toContain("FOO=");
    expect(get("src/env.d.ts")).toContain("FOO?: string;");
    assertParses("a.ts", out);
  });
  it("uses bracket access for names that are not identifiers and a computed name with a review note", () => {
    const { out, r } = convertOne("a.ts", `const x = Deno.env.get("MY-VAR"); const k = "z"; const y = Deno.env.get(k);`);
    expect(out).toContain('env["MY-VAR"]');
    expect(out).toContain("[k]");
    expect(sev(r, "deno-env")).toContain("review");
  });
  it("aliases the import when the file already has an `env` identifier", () => {
    const { out } = convertOne("a.ts", `const env = 1; const x = Deno.env.get("A");`);
    expect(out).toContain("env as cfEnv");
    expect(out).toContain("cfEnv.A");
    assertParses("a.ts", out);
  });
  it("Deno.env.set is manual and adds no import", () => {
    const { out, r } = convertOne("a.ts", `Deno.env.set("A", "1");`);
    expect(sev(r, "deno-env-write")).toEqual(["manual"]);
    expect(out).not.toContain("cloudflare:workers");
  });
  it("targets process.env on the node target", () => {
    const { out } = convertOne("a.ts", `const a = Deno.env.get("FOO");`, { target: "node" });
    expect(out).toContain("process.env.FOO");
    expect(out).not.toContain("cloudflare:workers");
  });
});

describe("Deno KV", () => {
  const src = `const kv = await Deno.openKv();
await kv.set(["users", 1], { a: 1 });
const e = await kv.get<{ a: number }>(["users", 1]);
for await (const x of kv.list({ prefix: ["users"] }, { reverse: true })) console.log(x.key);
export type K = Deno.KvKey;`;
  it("rewrites openKv and Deno.Kv* types to the helper and flags consistency", () => {
    const { out, r, get } = convertOne("a.ts", src);
    expect(out).toContain(`await openKv()`);
    expect(out).toContain(`import { openKv, type KvKey } from "./exit-ramp/kv";`);
    expect(out).not.toContain("Deno.");
    expect(sev(r, "deno-kv")).toEqual(["review"]);
    expect(sev(r, "deno-kv-tuple-keys")).toEqual(["info"]);
    expect(sev(r, "deno-kv-list-range")).toEqual(["review"]);
    expect(get("src/exit-ramp/kv.ts")).toContain("class Kv");
    expect(get("src/exit-ramp/kv-codec.ts")).toContain("encodeKey");
    expect(get("migrate/deno-kv-export.ts")).toContain("toBulk");
    expect(get("wrangler.toml")).toContain("[[kv_namespaces]]");
    assertParses("a.ts", out);
  });
  it("atomic().check() is manual; atomic() without check is review; sum/enqueue/watch are manual", () => {
    const { r } = convertOne("a.ts", `const kv = await Deno.openKv();
await kv.atomic().check({ key: ["a"], versionstamp: null }).set(["a"], 1).commit();
await kv.atomic().set(["b"], 1).commit();
await kv.atomic().sum(["c"], 1n).commit();
await kv.enqueue({ x: 1 });
kv.watch([["a"]]);`);
    expect(sev(r, "deno-kv-atomic-check")).toEqual(["manual"]);
    expect(sev(r, "deno-kv-atomic")).toEqual(["review"]);
    expect(sev(r, "deno-kv-atomic-ops")).toEqual(["manual"]);
    expect(sev(r, "deno-kv-queue")).toEqual(["manual"]);
    expect(sev(r, "deno-kv-watch")).toEqual(["manual"]);
  });
  it("detects a Deno.Kv parameter in a file without openKv", () => {
    const { r, out } = convertOne("a.ts", `export async function f(kv: Deno.Kv) { await kv.atomic().check({ key: ["a"], versionstamp: null }).commit(); }`);
    expect(sev(r, "deno-kv-atomic-check")).toEqual(["manual"]);
    expect(out).toContain(`type Kv } from "./exit-ramp/kv"`);
  });
  it("is manual on the node target", () => {
    const { r } = convertOne("a.ts", `const kv = await Deno.openKv();`, { target: "node" });
    expect(sev(r, "deno-kv")).toEqual(["manual"]);
  });
  it("adds a relative helper path for nested files", () => {
    const r = convert(files({ "main.ts": `export {};`, "lib/deep/a.ts": `const kv = await Deno.openKv();` }));
    expect(r.output.find((f) => f.path === "src/lib/deep/a.ts")!.content).toContain(`"../../exit-ramp/kv"`);
  });
});

describe("imports", () => {
  it("maps npm:, esm.sh, CDN and jsr: imports to dependencies", () => {
    const { r, out, get } = convertOne(
      "a.ts",
      `import a from "npm:zod@3.23.8";
import b from "https://esm.sh/hono@4.6.0/cors";
import { c } from "https://cdn.skypack.dev/lodash-es@4.17.21";
import { join } from "jsr:@std/path@^1.0.0";
export { a, b, c, join };`,
    );
    const deps = Object.fromEntries(r.dependencies.map((d) => [d.name, d.range]));
    expect(deps["zod"]).toBe("3.23.8");
    expect(deps["hono"]).toBe("4.6.0");
    expect(deps["@std/path"]).toBe("npm:@jsr/std__path@^1.0.0");
    expect(out).toContain('"zod"');
    expect(out).toContain('"hono/cors"');
    expect(out).toContain('"@std/path"');
    expect(get(".npmrc")).toContain("@jsr:registry=https://npm.jsr.io");
    expect(JSON.parse(get("package.json")!).dependencies["@std/path"]).toBe("npm:@jsr/std__path@^1.0.0");
    assertParses("a.ts", out);
  });
  it("reads deno.json import maps (with comments) and does not copy deno.json", () => {
    const r = convert(files({ "deno.json": `{ // c\n "imports": { "hono": "npm:hono@^4" } }`, "a.ts": `import { Hono } from "hono"; export const x = Hono;` }));
    expect(r.dependencies).toContainEqual({ name: "hono", range: "^4" });
    expect(r.output.some((f) => f.path.endsWith("deno.json"))).toBe(false);
  });
  it("flags deno.land/x, esm.town vals and other URLs as manual", () => {
    const { r } = convertOne("a.ts", `import a from "https://deno.land/x/foo@1/mod.ts"; import b from "https://esm.town/v/u/v"; import c from "https://example.com/x.js"; export { a, b, c };`);
    expect(sev(r, "import-deno-x")).toEqual(["manual"]);
    expect(sev(r, "import-esm-town")).toEqual(["manual"]);
    expect(r.findings.some((f) => f.severity === "manual" && f.message.includes("example.com"))).toBe(true);
  });
  it("rewrites the @jsxImportSource pragma", () => {
    const { out, r } = convertOne("a.tsx", `/** @jsxImportSource https://esm.sh/react@18.2.0 */\nexport default () => <div />;`);
    expect(out).toContain("@jsxImportSource react");
    expect(r.dependencies).toContainEqual({ name: "react", range: "18.2.0" });
  });
});

describe("Val Town: std modules", () => {
  it("std/sqlite -> D1 helper (binding DB), both val-scoped and global paths", () => {
    for (const spec of ["https://esm.town/v/std/sqlite", "https://esm.town/v/std/sqlite/main.ts", "https://esm.town/v/std/sqlite/global.ts", "https://esm.town/v/std/sqlite?v=4"]) {
      const { out, r, get } = convertOne("a.ts", `import { sqlite } from "${spec}"; await sqlite.execute("select 1");`);
      expect(out).toContain(`from "./exit-ramp/sqlite"`);
      expect(r.bindings.d1).toBe(true);
      expect(get("wrangler.toml")).toContain("[[d1_databases]]");
      expect(get("src/exit-ramp/sqlite.ts")).toContain("D1Sqlite");
      assertParses("a.ts", out);
    }
  });
  it("std/blob -> R2 helper, std/email -> Email Service helper", () => {
    const { r, get } = convertOne("a.ts", `import { blob } from "https://esm.town/v/std/blob"; import { email } from "https://esm.town/v/std/email"; await blob.get("a"); await email({ subject: "x" });`);
    expect(r.bindings).toMatchObject({ r2: true, email: true });
    expect(get("wrangler.toml")).toContain("[[r2_buckets]]");
    expect(get("wrangler.toml")).toContain("[[send_email]]");
    expect(get(".dev.vars.example")).toContain("EXIT_RAMP_EMAIL_FROM=");
  });
  it("named imports the helper does not provide are manual (never silently broken)", () => {
    const { r } = convertOne("a.ts", `import { sqlite, somethingElse } from "https://esm.town/v/std/sqlite"; sqlite; somethingElse;`);
    expect(sev(r, "import-valtown-std-sqlite")).toEqual(["manual"]);
  });
  it("std/openai and std/utils are manual with advice; versioned std paths are normalized", () => {
    const { r } = convertOne("a.ts", `import { OpenAI } from "https://esm.town/v/std/openai"; import { serveFile, readFile } from "https://esm.town/v/std/utils@85-main/index.ts"; OpenAI; serveFile; readFile;`);
    expect(sev(r, "import-valtown-std-openai")).toEqual(["manual"]);
    const u = r.findings.find((f) => f.rule === "import-valtown-std-utils");
    expect(u?.severity).toBe("manual");
    expect(u?.message).toMatch(/serveFile: Put public files in Workers Static Assets/);
  });
  it("flags *.val.run and @valtown.email addresses", () => {
    const { r } = convertOne("a.ts", `const u = "https://me-app.val.run/x"; const m = "bot@valtown.email";`);
    expect(r.findings.filter((f) => f.rule === "valtown-url")).toHaveLength(2);
  });
  it("flags the Val Town API token env var", () => {
    const { r } = convertOne("a.ts", `const t = Deno.env.get("valtown");`);
    expect(sev(r, "valtown-api-token")).toEqual(["manual"]);
  });
});

describe("Val Town: val types", () => {
  it("detects http/cron/email by file name and by signature", () => {
    const r = scan(files({
      "a.http.ts": `export default async function (req: Request) { return new Response("x"); }`,
      "b.cron.ts": `export default async function (interval: Interval) {}`,
      "c.email.ts": `export default async function (email: Email) {}`,
      "d.ts": `export default async function (req: Request): Promise<Response> { return new Response("d"); }`,
      "e.ts": `export default async function (interval: Interval) { interval.lastRunAt; }`,
      "f.ts": `export default async function (email: Email) { email.subject; }`,
      "g.ts": `import { Hono } from "npm:hono"; const app = new Hono(); export default app.fetch;`,
      "h.ts": `export const util = 1;`,
    }));
    const kinds = Object.fromEntries(r.files.map((f) => [f.path, f.kind]));
    expect(kinds).toEqual({ "a.http.ts": "http", "b.cron.ts": "cron", "c.email.ts": "email", "d.ts": "http", "e.ts": "cron", "f.ts": "email", "g.ts": "http", "h.ts": "module" });
  });
  it("honors explicit entrypoint overrides", () => {
    const r = scan(files({ "x.ts": `export default async function (a: unknown) {}` }), { entrypoints: { "x.ts": "cron" } });
    expect(r.files[0].kind).toBe("cron");
  });
  it("cron val without a schedule is manual and writes no trigger; with a schedule it is wired", () => {
    const code = `export default async function (i: Interval) { console.log(i.lastRunAt); }`;
    const a = convertOne("job.cron.ts", code);
    expect(sev(a.r, "val-cron-schedule")).toEqual(["manual"]);
    expect(a.get("wrangler.toml")).toContain("TODO(exit-ramp)");
    const b = convertOne("job.cron.ts", code, { crons: { "job.cron.ts": "30 6 * * 1" } });
    expect(sev(b.r, "val-cron-schedule")).toEqual(["review"]);
    expect(b.get("wrangler.toml")).toContain('crons = ["30 6 * * MON"]');
    expect(b.get("src/worker.ts")).toContain("getLastRun");
    expect(b.get("src/valtown-types.d.ts")).toContain("type Interval");
    expect(b.get("src/exit-ramp/last-run.ts")).toBeTruthy();
    expect(b.r.bindings.kv).toBe(true);
  });
  it("rejects an invalid cron expression instead of writing it", () => {
    const { r, get } = convertOne("job.cron.ts", `export default async function (i: Interval) {}`, { crons: { "job.cron.ts": "every day" } });
    expect(sev(r, "val-cron-schedule")).toEqual(["manual"]);
    expect(get("wrangler.toml")).not.toContain("every day");
  });
  it("email val is wired through postal-mime and adds the dependency", () => {
    const { r, get } = convertOne("m.email.ts", `export default async function (email: Email) { console.log(email.subject); }`);
    expect(get("src/worker.ts")).toContain("toValTownEmail");
    expect(get("src/exit-ramp/email-in.ts")).toContain("postal-mime");
    expect(r.dependencies.some((d) => d.name === "postal-mime")).toBe(true);
    expect(get("src/valtown-types.d.ts")).toContain("type Email");
  });
  it("warns when several HTTP entry points exist", () => {
    const r = convert(files({ "a.http.ts": `export default (r: Request) => new Response("a");`, "b.http.ts": `export default (r: Request) => new Response("b");` }));
    expect(r.warnings.join(" ")).toMatch(/Several HTTP entry points/);
  });
});

describe("leftover Deno.* APIs", () => {
  it("each gets a specific manual finding and a TODO comment above the statement", () => {
    const src = `await Deno.readTextFile("x"); Deno.exit(1); const c = new Deno.Command("ls"); const w = Deno.args;`;
    const { r, out } = convertOne("a.ts", src);
    for (const rule of ["deno-readTextFile", "deno-exit", "deno-Command", "deno-args"]) expect(sev(r, rule)).toEqual(["manual"]);
    expect(out).toContain("TODO(exit-ramp:deno-Command)");
    assertParses("a.ts", out);
  });
  it("does not report Deno.* that were rewritten", () => {
    const { r } = convertOne("a.ts", `Deno.serve(() => new Response("x")); const a = Deno.env.get("A"); const kv = await Deno.openKv();`);
    expect(r.findings.some((f) => /^deno-(serve|env|openKv)$/.test(f.rule) && f.severity === "manual")).toBe(false);
    expect(r.findings.some((f) => f.rule === "deno-openKv")).toBe(false);
  });
});

describe("node target", () => {
  it("generates a node:http server and croner jobs; flags unsupported services", () => {
    const r = convert(files({ "main.ts": `Deno.serve((req) => new Response("x")); Deno.cron("t", "*/5 * * * *", () => {});` }), { target: "node" });
    const server = r.output.find((f) => f.path === "src/server.ts")!.content;
    expect(server).toContain('from "node:http"');
    expect(server).toContain("new Cron(");
    expect(r.output.some((f) => f.path === "wrangler.toml")).toBe(false);
    const pkg = JSON.parse(r.output.find((f) => f.path === "package.json")!.content);
    expect(pkg.dependencies.croner).toBeTruthy();
    expect(pkg.scripts.start).toContain("tsx");
    assertParses("server.ts", server);
  });
  it("val email is manual on node", () => {
    const { r } = convertOne("a.email.ts", `export default async function (email: Email) {}`, { target: "node" });
    expect(sev(r, "val-email")).toEqual(["manual"]);
  });
});

describe("whole-project behavior", () => {
  it("fixtures: valtown-app", () => {
    const r = convert(fixture("valtown-app"), { crons: { "digest.cron.ts": "0 9 * * 1" } });
    expect(r.detected.platform).toBe("val-town");
    expect(r.files.map((f) => f.kind).sort()).toEqual(["cron", "email", "http", "module"]);
    for (const f of r.output.filter((o) => /\.tsx?$/.test(o.path))) assertParses(f.path, f.content);
  });
  it("fixtures: deno-app", () => {
    const r = convert(fixture("deno-app"));
    expect(r.detected.platform).toBe("deno-deploy");
    expect(r.findings.some((f) => f.rule === "deno-kv-atomic-check" && f.file === "locks.ts")).toBe(true);
    for (const f of r.output.filter((o) => /\.tsx?$/.test(o.path))) assertParses(f.path, f.content);
  });
  it("fixtures: leftovers has low confidence and is honest about it", () => {
    const r = scan(fixture("leftovers"));
    expect(r.overall.band).toBe("low");
    expect(r.findings.filter((f) => f.severity === "manual").length).toBeGreaterThanOrEqual(6);
  });
  it("strips a shared top-level folder and ignores node_modules, .git and lockfiles", () => {
    const r = scan(files({ "proj/main.ts": `Deno.serve(() => new Response("x"));`, "proj/deno.lock": "{}", "proj/node_modules/x/index.js": "x", "proj/.git/config": "" }));
    expect(r.files.map((f) => f.path)).toEqual(["main.ts"]);
  });
  it("empty and non-code input produce warnings, not crashes", () => {
    expect(scan([]).warnings.join(" ")).toMatch(/No JavaScript or TypeScript/);
    expect(scan(files({ "README.md": "hi" })).overall.confidence).toBe(0);
  });
  it("a file with a syntax error does not crash the run", () => {
    const r = scan(files({ "bad.ts": `const = ;; export default (`, "ok.ts": `export const a = 1;` }));
    expect(r.files.some((f) => f.path === "ok.ts")).toBe(true);
  });
  it("scan never produces output; convert is deterministic", () => {
    const f = fixture("deno-simple");
    expect((scan(f) as unknown as { output?: unknown }).output).toBeUndefined();
    expect(JSON.stringify(convert(f).output)).toBe(JSON.stringify(convert(f).output));
  });
  it("converting twice is stable: converted output has nothing left to rewrite", () => {
    const first = convert(fixture("deno-simple"));
    const again = scan(first.output.filter((o) => /^src\/(?!worker\.ts|exit-ramp|env)/.test(o.path)).map((o) => ({ path: o.path.replace(/^src\//, ""), text: o.content })));
    expect(again.findings.filter((f) => f.rule === "deno-serve" || f.rule === "deno-cron")).toHaveLength(0);
  });
});
