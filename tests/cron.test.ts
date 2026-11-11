import { describe, expect, it } from "vitest";
import { denoScheduleToUnix, unixCronToCloudflare } from "../src/core/cron";

describe("unixCronToCloudflare", () => {
  it("leaves wildcard schedules alone", () => {
    expect(unixCronToCloudflare("*/5 * * * *")).toMatchObject({ ok: true, expr: "*/5 * * * *", notes: [] });
  });
  it("rewrites numeric weekdays to names because Cloudflare numbers them 1=Sunday", () => {
    expect(unixCronToCloudflare("0 9 * * 1").expr).toBe("0 9 * * MON");
    expect(unixCronToCloudflare("0 9 * * 0").expr).toBe("0 9 * * SUN");
    expect(unixCronToCloudflare("0 9 * * 7").expr).toBe("0 9 * * SUN");
    expect(unixCronToCloudflare("0 9 * * 6").expr).toBe("0 9 * * SAT");
  });
  it("handles ranges and lists of weekdays", () => {
    expect(unixCronToCloudflare("0 3 * * 1-5").expr).toBe("0 3 * * MON-FRI");
    expect(unixCronToCloudflare("0 3 * * 1,3,5").expr).toBe("0 3 * * MON,WED,FRI");
  });
  it("keeps names as they are", () => {
    expect(unixCronToCloudflare("0 3 * * mon-fri").expr.toUpperCase()).toBe("0 3 * * MON-FRI");
  });
  it("expands @aliases", () => {
    expect(unixCronToCloudflare("@daily").expr).toBe("0 0 * * *");
    expect(unixCronToCloudflare("@hourly").expr).toBe("0 * * * *");
  });
  it("rejects expressions with the wrong number of fields", () => {
    const r = unixCronToCloudflare("* * * *");
    expect(r.ok).toBe(false);
    expect(r.notes.join(" ")).toMatch(/5 fields|five/i);
  });
});

describe("denoScheduleToUnix", () => {
  it("converts every/exact/range objects", () => {
    expect(denoScheduleToUnix({ minute: { every: 20 } }).expr).toBe("*/20 * * * *");
    expect(denoScheduleToUnix({ minute: 0, hour: { exact: [9, 17] } }).expr).toBe("0 9,17 * * *");
    expect(denoScheduleToUnix({ minute: 0, hour: { start: 9, end: 17 }, dayOfWeek: { start: 1, end: 5 } }).expr).toBe("0 9-17 * * 1-5");
  });
  it("defaults missing fields to *", () => {
    expect(denoScheduleToUnix({}).expr).toBe("* * * * *");
  });
});
