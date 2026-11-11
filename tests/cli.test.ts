import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli/index";
import { ROOT } from "./helpers";

function run(argv: string[], env: Record<string, string | undefined> = {}, cwd = ROOT) {
  let out = "";
  let err = "";
  return main(argv, { out: (s) => (out += s + "\n"), err: (s) => (err += s + "\n"), env, cwd }).then((code) => ({ code, out, err }));
}
const fx = (n: string) => join(ROOT, "fixtures", n);
const tmp = () => mkdtempSync(join(tmpdir(), "exit-ramp-"));

describe("cli", () => {
  it("scan prints a report and exits 0", async () => {
    const r = await run(["scan", fx("deno-app")]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Overall confidence: \d+\/100/);
  });
  it("scan --format json is parseable; github-summary and markdown work", async () => {
    expect(JSON.parse((await run(["scan", fx("deno-app"), "--format", "json"])).out).files).toHaveLength(3);
    expect((await run(["scan", fx("deno-app"), "--format", "github-summary"])).out).toMatch(/^## exit-ramp scan/);
    expect((await run(["scan", fx("deno-app"), "--format", "markdown"])).out).toMatch(/^# exit-ramp migration report/);
  });
  it("--fail-under and --fail-on-manual set exit code 1", async () => {
    expect((await run(["scan", fx("leftovers"), "--fail-under", "50"])).code).toBe(1);
    expect((await run(["scan", fx("deno-simple"), "--fail-under", "50"])).code).toBe(0);
    expect((await run(["scan", fx("deno-app"), "--fail-on-manual"])).code).toBe(1);
    expect((await run(["scan", fx("deno-simple"), "--fail-on-manual"])).code).toBe(0);
  });
  it("reads exit-ramp.config.json (cron schedule) and --cron overrides it", async () => {
    const a = await run(["scan", fx("valtown-app"), "--format", "json"]);
    expect(JSON.parse(a.out).bindings.cronSchedules).toContainEqual({ file: "digest.cron.ts", schedule: "0 9 * * MON" });
    const b = await run(["scan", fx("valtown-app"), "--format", "json", "--cron", "digest.cron.ts=0 6 * * *"]);
    expect(JSON.parse(b.out).bindings.cronSchedules).toContainEqual({ file: "digest.cron.ts", schedule: "0 6 * * *" });
  });
  it("convert writes the project and refuses a non-empty directory without --force", async () => {
    const out = tmp();
    const r = await run(["convert", fx("deno-simple"), "--out", out, "--name", "demo"]);
    expect(r.code).toBe(0);
    for (const f of ["wrangler.toml", "package.json", "src/worker.ts", "src/main.ts", "MIGRATION_REPORT.md"]) expect(existsSync(join(out, f)), f).toBe(true);
    const again = await run(["convert", fx("deno-simple"), "--out", out]);
    expect(again.code).toBe(2);
    expect(again.err).toMatch(/not empty/);
    expect((await run(["convert", fx("deno-simple"), "--out", out, "--force"])).code).toBe(0);
  });
  it("convert --target node writes a server and no wrangler.toml", async () => {
    const out = tmp();
    expect((await run(["convert", fx("deno-simple"), "--out", out, "--target", "node"])).code).toBe(0);
    expect(existsSync(join(out, "src/server.ts"))).toBe(true);
    expect(existsSync(join(out, "wrangler.toml"))).toBe(false);
  });
  it("usage errors exit 2 with a message", async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(["scan"])).err).toMatch(/needs a directory/);
    expect((await run(["scan", "/definitely/not/here"])).err).toMatch(/does not exist/);
    expect((await run(["scan", fx("deno-simple"), "--target", "lambda"])).err).toMatch(/--target/);
    expect((await run(["scan", fx("deno-simple"), "--bogus"])).code).toBe(2);
    expect((await run(["frobnicate", "x"])).err).toMatch(/Unknown command/);
    expect((await run(["scan", fx("deno-simple"), "--cron", "nonsense"])).err).toMatch(/<file>=<value>/);
    expect((await run(["scan", fx("deno-simple"), "--compat-date", "yesterday"])).err).toMatch(/compat-date/);
  });
  it("skips binary files with a warning instead of corrupting them", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "main.ts"), `Deno.serve(() => new Response("x"));`);
    writeFileSync(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0, 1, 2]));
    const r = await run(["scan", dir, "--format", "json"]);
    expect(JSON.parse(r.out).warnings.join(" ")).toMatch(/logo\.png: binary file/);
  });
  it("ignores node_modules and .git when reading a directory", async () => {
    const dir = tmp();
    mkdirSync(join(dir, "node_modules/x"), { recursive: true });
    writeFileSync(join(dir, "node_modules/x/i.js"), "Deno.serve(()=>{})");
    writeFileSync(join(dir, "main.ts"), `export const a = 1;`);
    expect(JSON.parse((await run(["scan", dir, "--format", "json"])).out).files).toHaveLength(1);
  });
  it("export needs the token from the environment, never a flag", async () => {
    const r = await run(["export", "--out", tmp()]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/VAL_TOWN_API_KEY/);
    expect((await run(["export", "--out", tmp(), "--token", "abc"])).code).toBe(2);
  });
});

describe("built CLI binary", () => {
  it("dist/cli.mjs runs end to end", () => {
    const b = spawnSync("node", ["scripts/build-cli.mjs"], { cwd: ROOT, encoding: "utf8" });
    expect(b.status, b.stderr).toBe(0);
    const r = spawnSync("node", ["dist/cli.mjs", "scan", "fixtures/deno-simple", "--format", "json"], { cwd: ROOT, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).detected.platform).toBe("deno-deploy");
    const h = spawnSync("node", ["dist/cli.mjs", "--help"], { cwd: ROOT, encoding: "utf8" });
    expect(h.stdout).toMatch(/exit-ramp scan <dir>/);
    expect(readFileSync(join(ROOT, "dist/cli.mjs"), "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
  }, 60000);
});
