import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ROOT } from "./helpers";

const action = parse(readFileSync(join(ROOT, "action.yml"), "utf8")) as any;
const ci = parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8")) as any;

describe("action.yml", () => {
  it("is a composite action with inputs, outputs and setup-node", () => {
    expect(action.runs.using).toBe("composite");
    expect(Object.keys(action.inputs)).toEqual(expect.arrayContaining(["path", "target", "fail-under", "fail-on-manual", "crons"]));
    expect(Object.keys(action.outputs)).toEqual(["confidence", "band", "manual"]);
    expect(action.runs.steps[0].uses).toMatch(/^actions\/setup-node@v\d+$/);
    for (const s of action.runs.steps.filter((s: any) => s.run)) expect(s.shell).toBe("bash"); // composite run steps require a shell
  });
  it("never interpolates inputs into shell code (they go through env)", () => {
    for (const s of action.runs.steps.filter((s: any) => s.run)) expect(s.run).not.toMatch(/\$\{\{/);
  });
  it("outputs map to the scan step", () => {
    for (const o of Object.values(action.outputs) as any[]) expect(o.value).toMatch(/steps\.scan\.outputs\./);
  });
  it("makes no network calls and uploads nothing in the scan step", () => {
    const run = action.runs.steps.find((s: any) => s.id === "scan").run;
    expect(run).not.toMatch(/\bcurl\b|\bwget\b|upload-artifact|https?:\/\//);
  });
});

describe("action scan step executed locally", () => {
  beforeAll(() => {
    const b = spawnSync("node", ["scripts/build-cli.mjs"], { cwd: ROOT, encoding: "utf8" });
    expect(b.status, b.stderr).toBe(0);
  }, 60000);

  function runScan(env: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "action-"));
    const summary = join(dir, "summary.md");
    const output = join(dir, "output.txt");
    writeFileSync(summary, "");
    writeFileSync(output, "");
    const script = action.runs.steps.find((s: any) => s.id === "scan").run;
    const r = spawnSync("bash", ["-c", script], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH!, HOME: process.env.HOME!, GITHUB_ACTION_PATH: ROOT, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output, ...env } });
    return { ...r, summary: readFileSync(summary, "utf8"), output: readFileSync(output, "utf8") };
  }

  it("posts a job summary and sets outputs", () => {
    const r = runScan({ INPUT_PATH: "fixtures/deno-simple", INPUT_TARGET: "workers", INPUT_FAIL_UNDER: "", INPUT_FAIL_ON_MANUAL: "false", INPUT_CRONS: "" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.summary).toMatch(/^## exit-ramp scan/);
    expect(r.output).toMatch(/confidence=\d+/);
    expect(r.output).toMatch(/band=(high|medium|low)/);
    expect(r.output).toMatch(/manual=0/);
  });
  it("fails with an error annotation when below --fail-under, still writing the summary", () => {
    const r = runScan({ INPUT_PATH: "fixtures/leftovers", INPUT_TARGET: "workers", INPUT_FAIL_UNDER: "90", INPUT_FAIL_ON_MANUAL: "false", INPUT_CRONS: "" });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/::error::exit-ramp/);
    expect(r.summary).toMatch(/exit-ramp scan/);
  });
  it("fail-on-manual and multi-line crons input work", () => {
    expect(runScan({ INPUT_PATH: "fixtures/deno-app", INPUT_TARGET: "workers", INPUT_FAIL_UNDER: "", INPUT_FAIL_ON_MANUAL: "true", INPUT_CRONS: "" }).status).toBe(1);
    const r = runScan({ INPUT_PATH: "fixtures/valtown-app", INPUT_TARGET: "workers", INPUT_FAIL_UNDER: "", INPUT_FAIL_ON_MANUAL: "false", INPUT_CRONS: "digest.cron.ts=0 6 * * *\n" });
    expect(r.status, r.stderr).toBe(0);
  });
  it("a missing path is a clear error (exit 2)", () => {
    const r = runScan({ INPUT_PATH: "nope", INPUT_TARGET: "workers", INPUT_FAIL_UNDER: "", INPUT_FAIL_ON_MANUAL: "false", INPUT_CRONS: "" });
    expect(r.status).toBe(2);
  });
});

describe("ci workflow", () => {
  it("runs on push and pull_request with read-only permissions and the full check", () => {
    expect(Object.keys(ci.on)).toEqual(expect.arrayContaining(["push", "pull_request"]));
    expect(ci.permissions).toEqual({ contents: "read" });
    const text = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(text).toMatch(/npm run ci|npm test/);
    expect(text).not.toMatch(/secrets\./); // CI needs no secrets
  });
});
