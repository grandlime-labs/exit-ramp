import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./helpers";

describe("LAUNCH.md", () => {
  it("X posts fit in 280 characters and no invented statistics appear", () => {
    const r = spawnSync("node", ["scripts/check-launch.mjs"], { cwd: ROOT, encoding: "utf8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
  it("is clearly marked as drafts and has every required section", () => {
    const md = readFileSync(join(ROOT, "LAUNCH.md"), "utf8");
    expect(md).toMatch(/Nothing in this file has been posted/);
    for (const h of ["Landing page copy", "Show HN", "Val Town thread", "denoland/deno#37030|issue #37030", "Three X posts"]) expect(md).toMatch(new RegExp(h));
  });
  it("states the platform dates consistently with the README", () => {
    const md = readFileSync(join(ROOT, "LAUNCH.md"), "utf8");
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    for (const d of ["2026-12-10", "2027-01-10", "2026-10-09"]) {
      expect(md).toContain(d);
      expect(readme).toContain(d);
    }
  });
  it("pricing design builds nothing and says so", () => {
    const md = readFileSync(join(ROOT, "docs/PRICING-DESIGN.md"), "utf8");
    expect(md).toMatch(/design only/i);
    expect(md).toMatch(/Lemon Squeezy/);
  });
});
