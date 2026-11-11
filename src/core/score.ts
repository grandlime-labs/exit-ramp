import type { Band, Finding, Severity } from "./types";

/** Penalty per finding, by severity. A file starts at 100 and never goes below 0. */
export const PENALTY: Record<Severity, number> = { info: 0, auto: 0, review: 8, manual: 22 };

export function bandOf(score: number): Band {
  return score >= 85 ? "high" : score >= 60 ? "medium" : "low";
}

export function scoreFindings(findings: Pick<Finding, "severity">[]): number {
  let s = 100;
  for (const f of findings) s -= PENALTY[f.severity];
  return Math.max(0, s);
}

export function countBySeverity(findings: Pick<Finding, "severity">[]): Record<Severity, number> {
  const c: Record<Severity, number> = { auto: 0, review: 0, manual: 0, info: 0 };
  for (const f of findings) c[f.severity]++;
  return c;
}

/** Project score: mean of file scores, capped by the worst file + 25 so one broken file is never averaged away. */
export function overallConfidence(scores: number[]): number {
  if (!scores.length) return 0;
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  return Math.round(Math.min(mean, Math.min(...scores) + 25));
}
