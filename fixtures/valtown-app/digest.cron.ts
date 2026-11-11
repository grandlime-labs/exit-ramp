import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";

export default async function (interval: Interval) {
  const since = interval.lastRunAt ? interval.lastRunAt.getTime() : 0;
  const rs = await sqlite.execute(`SELECT count(*) AS n FROM notes`).catch(() => ({ rows: [{ n: 0 }] }));
  console.log("digest", { since, notes: rs.rows[0] });
}
