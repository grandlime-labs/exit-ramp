import { describe, expect, it } from "vitest";
import { convert, fixture, scan } from "./helpers";
import { renderGithubSummary, renderJson, renderMarkdown, renderText } from "../src/core/index";

describe("report formats", () => {
  const r = scan(fixture("deno-app"));
  it("text lists per-file confidence and MANUAL/REVIEW findings", () => {
    const t = renderText(r);
    expect(t).toMatch(/locks\.ts\s+\d+\s+(high|medium|low)/);
    expect(t).toMatch(/MANUAL locks\.ts:\d+/);
    expect(t).toMatch(/REVIEW main\.ts/);
  });
  it("json round-trips and has no output field", () => {
    const j = JSON.parse(renderJson(convert(fixture("deno-app"))));
    expect(j.files.length).toBe(3);
    expect(j.output).toBeUndefined();
    expect(j.overall.band).toMatch(/high|medium|low/);
  });
  it("markdown has sections per severity and doc links", () => {
    const md = renderMarkdown(r);
    expect(md).toMatch(/## MANUAL \(\d+\)/);
    expect(md).toMatch(/## REVIEW \(\d+\)/);
    expect(md).toMatch(/\]\(https:\/\/developers\.cloudflare\.com/);
  });
  it("github summary is compact markdown with a table and stays under the 1 MiB limit", () => {
    const s = renderGithubSummary(r);
    expect(s).toMatch(/^## exit-ramp scan/);
    expect(s).toMatch(/\| Manual \| Review \| Auto \| Info \|/);
    expect(s).toMatch(/<details>/);
    expect(Buffer.byteLength(s)).toBeLessThan(1024 * 1024);
  });
  it("escapes pipes so file names cannot break tables", () => {
    const x = scan([{ path: "a|b.ts", text: `Deno.serve(() => new Response("x"));` }]);
    expect(renderGithubSummary(x)).toContain("a\\|b.ts");
  });
});
