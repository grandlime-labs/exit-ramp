/**
 * Cron conversion. Val Town, Deno.cron and classic crontab use 0 (or 7) = Sunday for the weekday field.
 * Cloudflare Workers Cron Triggers number weekdays 1 = Sunday ... 7 = Saturday
 * (https://developers.cloudflare.com/workers/configuration/cron-triggers/). A numeric weekday copied across unchanged
 * runs on the wrong day, so every numeric weekday is rewritten to its three-letter name.
 */

const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const ALIASES: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

export interface CronConversion {
  ok: boolean;
  expr: string;
  /** Human-readable notes about anything that was changed or could not be verified. */
  notes: string[];
}

function dowToken(tok: string, notes: string[]): string | undefined {
  const step = tok.match(/^(.*)\/(\d+)$/);
  const base = step ? step[1] : tok;
  const suffix = step ? "/" + step[2] : "";
  if (base === "*" || base === "?") {
    if (step) notes.push(`weekday step "${tok}" counts positions, not names: check it against Cloudflare's 1=Sunday numbering`);
    return base === "?" ? "*" : tok;
  }
  const range = base.match(/^(\w+)-(\w+)$/);
  const one = (s: string): string | undefined => {
    if (/^[A-Za-z]{3}$/.test(s)) return s.toUpperCase();
    if (/^\d$/.test(s)) {
      const n = Number(s);
      if (n >= 0 && n <= 7) return DOW[n % 7];
    }
    return undefined;
  };
  if (range) {
    const a = one(range[1]);
    const b = one(range[2]);
    if (!a || !b) return undefined;
    if (DOW.indexOf(a) > DOW.indexOf(b) && b !== "SUN") notes.push(`weekday range "${tok}" wraps around the week; Cloudflare may reject it`);
    return `${a}-${b}${suffix}`;
  }
  const v = one(base);
  return v ? v + suffix : undefined;
}

/** Convert a 5-field unix cron expression to Cloudflare syntax. */
export function unixCronToCloudflare(input: string): CronConversion {
  const notes: string[] = [];
  let expr = input.trim().replace(/\s+/g, " ");
  if (ALIASES[expr.toLowerCase()]) {
    notes.push(`${expr} expanded to "${ALIASES[expr.toLowerCase()]}"`);
    expr = ALIASES[expr.toLowerCase()];
  }
  const f = expr.split(" ");
  if (f.length !== 5) {
    return { ok: false, expr: input, notes: [`expected 5 fields, found ${f.length}. Cloudflare Cron Triggers take 5 fields (minute hour day-of-month month weekday).`] };
  }
  const tokens = f[4].split(",").map((t) => dowToken(t, notes));
  if (tokens.some((t) => t === undefined)) {
    return { ok: false, expr: input, notes: [`could not interpret the weekday field "${f[4]}"`] };
  }
  const newDow = tokens.join(",");
  if (newDow !== f[4] && /\d/.test(f[4])) notes.push(`weekday "${f[4]}" rewritten to "${newDow}" because Cloudflare numbers weekdays 1=Sunday (unix uses 0=Sunday)`);
  f[4] = newDow;
  return { ok: true, expr: f.join(" "), notes };
}

export interface DenoCronField {
  exact?: number | number[];
  start?: number;
  end?: number;
  every?: number;
}
export type DenoCronValue = number | DenoCronField | undefined;
export interface DenoCronSchedule {
  minute?: DenoCronValue;
  hour?: DenoCronValue;
  dayOfMonth?: DenoCronValue;
  month?: DenoCronValue;
  dayOfWeek?: DenoCronValue;
}

const BOUNDS: Record<keyof DenoCronSchedule, [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dayOfMonth: [1, 31],
  month: [1, 12],
  dayOfWeek: [0, 6],
};

/** Convert Deno.cron's object schedule ({ minute: { every: 20 } }, ...) to a unix expression. */
export function denoScheduleToUnix(s: DenoCronSchedule): CronConversion {
  const notes: string[] = [];
  const parts: string[] = [];
  for (const key of ["minute", "hour", "dayOfMonth", "month", "dayOfWeek"] as const) {
    const v = s[key];
    const [min, max] = BOUNDS[key];
    if (v === undefined) {
      parts.push("*");
    } else if (typeof v === "number") {
      parts.push(String(v));
    } else if (v.exact !== undefined) {
      parts.push(Array.isArray(v.exact) ? v.exact.join(",") : String(v.exact));
    } else {
      const start = v.start ?? min;
      const end = v.end ?? max;
      if (v.every !== undefined) {
        parts.push(start === min && end === max ? `*/${v.every}` : `${start}-${end}/${v.every}`);
      } else {
        parts.push(start === min && end === max ? "*" : `${start}-${end}`);
      }
    }
  }
  return { ok: true, expr: parts.join(" "), notes };
}
