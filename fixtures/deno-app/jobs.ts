import { encodeHex } from "@std/encoding/hex";

Deno.cron("nightly cleanup", "0 3 * * 1-5", () => {
  console.log("cleanup", encodeHex(new Uint8Array([1, 2, 3])));
});

Deno.cron("every 20 minutes", { minute: { every: 20 } }, { backoffSchedule: [1000, 5000] }, async () => {
  console.log("sync");
});

Deno.cron("sundays", "30 6 * * 0", () => console.log("weekly"));
