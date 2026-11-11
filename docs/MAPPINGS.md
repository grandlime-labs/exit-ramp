# Mappings and sources

Every rule exit-ramp applies, with the document it is based on. Docs were read in November 2026; if a platform changes, the mapping may need updating. `src/core/imports.ts` holds the URL constants.

## Val Town -> Cloudflare

Source: <https://docs.val.town/migration/cloudflare> and its sub-pages (`migrate-code`, `migrate-crons`, `migrate-sqlite`, `migrate-blobs`, `migrate-email`, `migrate-ai`, `transfer-secrets`).

| Val Town | Cloudflare | Rule id(s) | Severity | Notes |
|---|---|---|---|---|
| HTTP val: `export default async function (req: Request)` or a Hono `app.fetch` / `export default app` | Worker `fetch(request, env, ctx)` | `val-http` | auto | Wired in the generated `src/worker.ts`. |
| Cron val: `export default async function (interval: Interval)` | `scheduled(controller, env, ctx)` + `[triggers] crons` | `val-cron-schedule`, `val-cron-lastRunAt` | manual until you supply a schedule, then review | The schedule is not in the source or the REST API. Both platforms use UTC. Cloudflare does not pass the last run time; stored in KV. |
| Email val: `export default async function (email: Email)` | Worker `email(message, env, ctx)` (Email Routing) | `val-email` | review | `postal-mime` rebuilds `{from, to, cc, bcc, subject, text, html, attachments, headers}`. |
| `std/sqlite` (`execute`, `batch`) | D1 | `import-valtown-std-sqlite` | review | `:name` / `@name` / `$name` rewritten to `?N`. Rows are objects. |
| `std/blob` (`get`, `getJSON`, `set`, `setJSON`, `delete`, `list`, `copy`, `move`) | R2 | `import-valtown-std-blob` | review | |
| `std/email` | Cloudflare Email Service `send_email` binding | `import-valtown-std-email` | review | No default sender/recipient on Cloudflare. |
| `std/openai` | AI Gateway + the `openai` package | `import-valtown-std-openai` | manual | |
| `std/utils` (`serveFile`, `readFile`, `hotReload`, …) | Static Assets / build-time reads / Vite | `import-valtown-std-utils` | manual | Per-function advice is included in the finding. |
| Other `std/*` | none | `import-valtown-std-<name>` | manual | |
| `https://esm.town/v/user/val` | copy the val's files in | `import-esm-town` | manual | Preserve license and attribution. |
| `https://esm.sh/pkg@x`, unpkg, jsDelivr, Skypack, `npm:` | `package.json` dependency | `import-esm-sh`, `import-cdn`, `import-npm` | auto | `/vNN/` and `?query` stripped. |
| `*.val.run`, `@valtown.email` | new URL / address | `valtown-url` | review | Redirects: <https://docs.val.town/migration/redirects>. |
| `Deno.env.get("valtown")` (API token) | none | `valtown-api-token` | manual | Stops working with the platform. |
| Env vars | Worker secrets | `deno-env` (info) | info | Only names are exported. |

## Deno Deploy -> Workers

Sources: Deno blog "Deno is joining Cloudflare" (2026-10-09), `denoland/deno#37030`, Deno KV manual, Cloudflare Workers/KV/Cron Triggers docs.

| Deno | Workers | Rule id(s) | Severity |
|---|---|---|---|
| `Deno.serve(handler)` / `(options, handler)` / `({handler})` | exported handler wired into `fetch()` | `deno-serve` | auto (review if options or the `info` argument are used) |
| `Deno.cron(name, "* * * * *", fn)` | `scheduled()` + cron trigger | `deno-cron` | auto (review if the expression changed, e.g. weekday names, or `backoffSchedule` is used) |
| `Deno.cron(name, { minute: { every: 20 } }, fn)` | object schedule converted to a cron expression | `deno-cron` | review |
| computed schedule | none (copy the value into `wrangler.toml`) | `deno-cron` | manual |
| `Deno.env.get/has/toObject` | `env.NAME` (`cloudflare:workers`) | `deno-env`, `deno-env-toObject` | auto / review |
| `Deno.env.set/delete` | none (env is read-only) | `deno-env-write` | manual |
| `Deno.openKv()` + `get/getMany/set/delete/list` | Workers KV helper | `deno-kv`, `deno-kv-tuple-keys`, `deno-kv-list-range`, `deno-kv-path` | review / info |
| `kv.atomic()` without `check` | sequential writes (not atomic) | `deno-kv-atomic` | review |
| `kv.atomic().check(...)` | throws unless `unsafeBestEffortChecks` | `deno-kv-atomic-check` | manual |
| `atomic().sum/min/max/enqueue`, `kv.enqueue/listenQueue/watch` | throw (use Durable Objects / Queues) | `deno-kv-atomic-ops`, `deno-kv-queue`, `deno-kv-watch` | manual |
| `Deno.Kv*` types | helper's exported types | n/a | auto |
| `jsr:@std/x@^1` | `"@std/x": "npm:@jsr/std__x@^1"` + `.npmrc` | `import-jsr` | auto |
| `https://deno.land/std@0.x/...` | JSR `@std/*` ^1 | `import-deno-std` | review |
| `https://deno.land/x/...` | none | `import-deno-x` | manual |
| `Deno.readTextFile`, `writeFile`, `Command`, `listen`, `exit`, `args`, `upgradeWebSocket`, … | none | `deno-<name>` | manual (with advice per API) |

## Deno KV vs Workers KV (why it is "review")

| | Deno KV | Workers KV |
|---|---|---|
| Consistency | strong by default | eventually consistent; changes can take 60 s or more to appear elsewhere; negative lookups are cached |
| Atomic / transactions | `atomic().check().set().commit()` with versionstamps | none (Cloudflare suggests Durable Objects) |
| Keys | arrays of parts | strings, max 512 bytes |
| Writes | | 1 write per second to the same key |
| Value size | 64 KiB | 25 MiB |
| TTL | `expireIn` | `expirationTtl`, minimum 60 s (the helper clamps) |
| `list` | ordered by tuple, start/end/reverse | ordered by key bytes, prefix + cursor only (the helper filters in memory) |

Key encoding (`templates/kv-codec.ts`): parts are tagged and escaped so the byte order of the encoded string matches Deno's tuple order (Uint8Array < string < bigint < number < boolean), including negative numbers and bigints. A property test compares it with a reference implementation of Deno's order.

## Cron

Cloudflare Cron Triggers: five fields, UTC, **weekdays numbered 1 = Sunday … 7 = Saturday** (unix: 0 = Sunday). exit-ramp rewrites numeric weekdays to `SUN`..`SAT` names so the meaning is unambiguous. Docs: <https://developers.cloudflare.com/workers/configuration/cron-triggers/>.
