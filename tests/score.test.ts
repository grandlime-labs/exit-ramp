import { describe, expect, it } from "vitest";
import { bandOf, overallConfidence, scoreFindings } from "../src/core/score";

describe("score", () => {
  it("starts at 100 and subtracts 22 per manual and 8 per review; auto/info are free", () => {
    expect(scoreFindings([])).toBe(100);
    expect(scoreFindings([{ severity: "auto" }, { severity: "info" }])).toBe(100);
    expect(scoreFindings([{ severity: "review" }, { severity: "manual" }])).toBe(70);
  });
  it("never goes below 0", () => {
    expect(scoreFindings(Array.from({ length: 10 }, () => ({ severity: "manual" as const })))).toBe(0);
  });
  it("bands: high >= 85, medium >= 60, else low", () => {
    expect([bandOf(100), bandOf(85), bandOf(84), bandOf(60), bandOf(59)]).toEqual(["high", "high", "medium", "medium", "low"]);
  });
  it("overall is capped by the worst file + 25 so one broken file is not averaged away", () => {
    expect(overallConfidence([100, 100, 100, 0])).toBe(25);
    expect(overallConfidence([80, 90])).toBe(85);
    expect(overallConfidence([])).toBe(0);
  });
});
