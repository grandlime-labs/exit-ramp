import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import { TEMPLATES } from "../src/core/templates.generated";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, convert, files, fixture } from "./helpers";

const get = (r: ReturnType<typeof convert>, p: string) => r.output.find((f) => f.path === p)?.content;

describe("generated project scaffold", () => {
  const r = convert(fixture("valtown-app"), { projectName: "My Cool App!", crons: { "digest.cron.ts": "0 9 * * 1" } });

  it("wrangler.toml is valid TOML with the expected bindings", () => {
    const t = parseToml(get(r, "wrangler.toml")!) as Record<string, any>;
    expect(t.name).toBe("my-cool-app");
    expect(t.main).toBe("src/worker.ts");
    expect(t.compatibility_date).toBe("2026-10-01");
    expect(t.compatibility_flags).toContain("nodejs_compat");
    expect(t.triggers.crons).toEqual(["0 9 * * MON"]);
    expect(t.kv_namespaces[0].binding).toBe("KV");
    expect(t.d1_databases[0]).toMatchObject({ binding: "DB", database_name: "my-cool-app-db" });
    expect(t.r2_buckets[0].binding).toBe("BLOB");
    expect(t.r2_buckets[0].bucket_name).toMatch(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/); // R2 bucket naming rules
    expect(t.send_email[0].name).toBe("EMAIL");
  });

  it("compatibility date is configurable", () => {
    const x = convert(files({ "a.ts": `Deno.serve(() => new Response("x"));` }), { compatibilityDate: "2026-11-01" });
    expect((parseToml(get(x, "wrangler.toml")!) as any).compatibility_date).toBe("2026-11-01");
  });

  it("package.json is valid with scripts, deps from imports, and pinned tool majors", () => {
    const p = JSON.parse(get(r, "package.json")!);
    expect(p.scripts).toMatchObject({ dev: "wrangler dev", deploy: "wrangler deploy", typecheck: "tsc --noEmit" });
    expect(p.dependencies).toMatchObject({ hono: "4.6.0", zod: "3", "postal-mime": "^4" });
    expect(Object.keys(p.devDependencies).sort()).toEqual(["@cloudflare/workers-types", "typescript", "wrangler"]);
    expect(Object.keys(p.dependencies)).toEqual([...Object.keys(p.dependencies)].sort());
  });

  it("tsconfig, .gitignore, env.d.ts and .dev.vars.example exist; secrets are never copied", () => {
    expect(JSON.parse(get(r, "tsconfig.json")!).compilerOptions.types).toEqual(["@cloudflare/workers-types"]);
    expect(get(r, ".gitignore")).toMatch(/\.dev\.vars/);
    expect(get(r, "src/env.d.ts")).toMatch(/KV: KVNamespace;[\s\S]*DB: D1Database;[\s\S]*BLOB: R2Bucket;[\s\S]*EMAIL: SendEmail;/);
    const vars = get(r, ".dev.vars.example")!;
    expect(vars).toContain("API_SECRET=");
    expect(vars).not.toMatch(/=\S/); // every value is empty
  });

  it("only includes the helpers a project uses", () => {
    const small = convert(files({ "a.ts": `Deno.serve(() => new Response("x"));` }));
    expect(small.output.some((f) => f.path.startsWith("src/exit-ramp/"))).toBe(false);
    expect(small.output.some((f) => f.path === "migrate/deno-kv-export.ts")).toBe(false);
    expect(JSON.parse(get(small, "package.json")!).dependencies).toEqual({});
    const wr = parseToml(get(small, "wrangler.toml")!) as Record<string, unknown>;
    expect(wr.kv_namespaces).toBeUndefined();
    expect(wr.triggers).toBeUndefined();
  });

  it("includes the report and a JSON report; the markdown lists resources and dependencies", () => {
    const md = get(r, "MIGRATION_REPORT.md")!;
    expect(md).toMatch(/Overall confidence/);
    expect(md).toMatch(/Resources to create/);
    expect(JSON.parse(get(r, "exit-ramp-report.json")!).overall.confidence).toBe(r.overall.confidence);
  });

  it("no generated file contains an obviously real secret-looking value", () => {
    for (const f of r.output) expect(f.content).not.toMatch(/(?:sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,})/);
  });
});

describe("templates", () => {
  it("templates.generated.ts is up to date with templates/*.ts", () => {
    const dir = join(ROOT, "templates");
    const names = readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => f.replace(/\.ts$/, "")).sort();
    expect(Object.keys(TEMPLATES).sort()).toEqual(names);
    for (const n of names) expect(TEMPLATES[n], `${n} is stale: run npm run gen`).toBe(readFileSync(join(dir, n + ".ts"), "utf8"));
  });
});
