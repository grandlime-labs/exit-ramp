# Deploy guide

exit-ramp never deploys anything and never needs your credentials. Everything below is something *you* run.

## 0. Before you touch production

1. Run `exit-ramp scan` and read the `MANUAL` list. Fix or accept each item.
2. Convert into a **new directory** (`--out`), never over your source.
3. Read `MIGRATION_REPORT.md`: it lists every resource you must create and every behavior that differs.
4. Keep the old deployment running until the new one is verified. Val Town: code is read-only from 2026-12-10, services stop 2027-01-10. Deno Deploy: about six months from the 2026-10-09 announcement.

## 1. Local run (no account needed)

```bash
cd my-worker
npm install
npm run typecheck
cp .dev.vars.example .dev.vars     # fill in secrets
npm run dev                        # wrangler dev: workerd locally, simulated KV / D1 / R2
```

Cron jobs locally: `wrangler dev --test-scheduled`, then `curl "http://localhost:8787/__scheduled?cron=0+9+*+*+MON"` (the `cron` value must equal the expression in `wrangler.toml`).
Email vals locally: `curl -X POST "http://localhost:8787/cdn-cgi/handler/email?from=a@b.c&to=x@y.z" --data-binary @message.eml`.

## 2. Create resources (only the ones the report lists)

Run `wrangler login` once. Then, depending on the report:

```bash
npx wrangler kv namespace create KV          # Deno KV replacement
npx wrangler d1 create my-app-db             # std/sqlite replacement
npx wrangler r2 bucket create my-app-blobs   # std/blob replacement
```

`wrangler.toml` lists each binding without an `id` (local dev works that way). For a real deploy, paste the ids the commands above print, or check whether your wrangler version can provision missing resources automatically: [wrangler configuration docs](https://developers.cloudflare.com/workers/wrangler/configuration/). That automatic path was not tested here.

Secrets (names are in `.dev.vars.example`): `npx wrangler secret put NAME`. Val Town's API never returns secret values: copy them from the Val Town UI while it still exists.

## 3. Move the data

| Source | How |
|---|---|
| Val Town sqlite -> D1 | Dump from Val Town ([guide](https://docs.val.town/migration/cloudflare/migrate-sqlite)), then `npx wrangler d1 execute my-app-db --remote --file dump.sql`. Val Town's blog says read-only mode on 2026-12-10 excludes sqlite and blob storage, which run until 2027-01-10. Move the data well before then anyway. |
| Val Town blob -> R2 | [guide](https://docs.val.town/migration/cloudflare/migrate-blobs) |
| Deno KV -> Workers KV | `deno run --allow-read --allow-write --unstable-kv migrate/deno-kv-export.ts [path-or-url]` writes `kv-bulk-0001.json` (10,000 entries per file) with the key encoding the Worker uses. Then `npx wrangler kv bulk put kv-bulk-0001.json --binding KV --remote`. Versionstamps, queues and expiry times are not carried over. |

Compare row/key counts before and after.

## 4. Deploy

```bash
npm run deploy
```

Then verify with real traffic: HTTP routes, one forced cron run, and (for email) a real message to the routed address. A local run proves wiring; it does not prove deliverability or production data.

## 5. Email

- Receiving (email vals): enable Email Routing for your domain and route the address to the Worker ([docs](https://developers.cloudflare.com/email-routing/email-workers/)). Old `@valtown.email` addresses do not transfer: update senders.
- Sending (`std/email`): onboard a domain for Cloudflare Email Service and set the secret `EXIT_RAMP_EMAIL_FROM`. Send to an inbox you control first.

## 6. Redirect old URLs

After verifying each app, redirect its `*.val.run` URL to the new one and update webhooks at their providers: <https://docs.val.town/migration/redirects>.

## 7. Cron cut-over

Disable the old schedule only after the new trigger has run once. Cloudflare crons run in UTC, like Val Town and Deno.cron, and cannot pass `lastRunAt`: the helper stores it in KV, which is eventually consistent, so make jobs safe to repeat.

---

## Deploying the web app (static)

```bash
npm run build:web          # -> dist-web/
```

- **Cloudflare Pages:** create a Pages project (direct upload or Git) with build command `npm run build:web` and output `dist-web`. `dist-web/_headers` carries the CSP and security headers.
- **GitHub Pages:** publish `dist-web`. GitHub Pages ignores `_headers`, so the CSP `<meta>` tag baked into `index.html` is what applies there (it lacks `frame-ancestors`).
- **Netlify:** build `npm run build:web`, publish `dist-web` (`_headers` is honored).

None of these has been done for you.

## Publishing the CLI (optional, not done)

`package.json` has `"private": true` so nothing can be published by accident. To publish, remove it, bundle with `npm run build:cli` (bundles ts-morph into `dist/cli.mjs`), and decide on a package name. The GitHub Action does not need npm: it builds from its own source.
