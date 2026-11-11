# exit-ramp

Move **Val Town** and **Deno Deploy** code to **Cloudflare Workers** (Node as a secondary target).
Scan first: it tells you, per file, what will move cleanly, what needs a human, and why.

- **Val Town** is winding down: code becomes read-only on **2026-12-10** (sqlite and blob storage are excluded from read-only mode and run until 2027-01-10), everything else stops on **2027-01-10**, and the code is to be open-sourced 2027-02-01 ([announcement](https://blog.val.town/winding-down), [migration guide](https://docs.val.town/migration)).
- **Deno Deploy** shuts down about six months after the **2026-10-09** announcement that Deno is joining Cloudflare ([blog](https://deno.com/blog/cloudflare)). The runtime gets LTS fixes until October 2027 ([denoland/deno#37030](https://github.com/denoland/deno/issues/37030)).

exit-ramp is deterministic: the same input gives the same output, every rewrite has a rule you can read, and anything it cannot convert safely is flagged instead of guessed. It does not replace testing your app.

## What is in this repo

| Part | Where | What it does |
|---|---|---|
| Core | `src/core` | ts-morph detector and rewriter, confidence report, `wrangler.toml` / `package.json` scaffold. Pure functions on in-memory files, so it runs in Node and in a browser. |
| CLI | `src/cli` | `exit-ramp scan`, `convert`, `export`. |
| Web app | `web` | Vite static site. Paste code or drop a folder; runs entirely in the tab under a strict CSP. |
| GitHub Action | `action.yml` | Composite action: runs the scan and writes a job summary. Read-only. |
| Fixtures | `fixtures` | One project per rule family, used by the tests and by `verify`. |

## Quick start

Requires Node 20+. The CLI is on npm as [`exit-ramp`](https://www.npmjs.com/package/exit-ramp):

```bash
# 1. See what you are dealing with (free, read-only)
npx exit-ramp scan path/to/your/project

# 2. Generate a Workers project
npx exit-ramp convert path/to/your/project --out ./my-worker --name my-app
cd my-worker && npm install && npm run typecheck && npm run dev
```

To work from a clone of this repo instead:

```bash
npm install
npm run build:cli
node dist/cli.mjs scan path/to/your/project
```

Read `MIGRATION_REPORT.md` in the output before deploying. Local development needs no Cloudflare account: `wrangler dev` runs the Worker in workerd with simulated KV, D1 and R2. Deploying is covered in [docs/DEPLOY.md](docs/DEPLOY.md).

### Val Town projects

Val Town stores a val's type (HTTP, cron, email) in its settings, not in the source. exit-ramp reads it from the file name (`main.http.ts`, `job.cron.ts`, `inbox.email.ts`), from the default export's signature (`Request`, `Interval`, `Email`), or from `--entry file=http|cron|email`. **Cron schedules are not exposed by the Val Town API**, so pass them yourself:

```bash
exit-ramp convert ./vals --cron "digest.cron.ts=0 9 * * 1" --out ./worker
# or put them in exit-ramp.config.json:  { "crons": { "digest.cron.ts": "0 9 * * 1" } }
```

Optional, read-only export of your vals (GET requests only; the token comes from an environment variable, never a flag):

```bash
VAL_TOWN_API_KEY=... exit-ramp export --out ./vals            # all your vals
VAL_TOWN_API_KEY=... exit-ramp export --val you/myVal --out ./vals
```

The API does not return secret values (only names, written to `ENV_VARS.txt`), so re-enter secrets with `wrangler secret put`.

### CLI reference

```
exit-ramp scan <dir>   [--target workers|node] [--format text|json|markdown|github-summary]
                       [--cron file=expr]... [--entry file=http|cron|email]... [--config path]
                       [--fail-under N] [--fail-on-manual]
exit-ramp convert <dir> --out <dir> [--name N] [--compat-date YYYY-MM-DD] [--force] [same options]
exit-ramp export [--val user/name] --out <dir>
```

Exit codes: `0` ok, `1` a `--fail-*` threshold failed (or an API error), `2` usage error.

### GitHub Action

```yaml
- uses: actions/checkout@v4
- uses: YOUR-ORG/exit-ramp@v1        # after you publish the repo
  with:
    path: .
    fail-under: 60                    # optional
```

It builds the scanner from the action's own source, scans the checked-out files, writes the summary to the job, and sets the outputs `confidence`, `band` and `manual`. It makes no network calls while scanning and uploads nothing.

### Web app

`npm run dev:web` for development, `npm run build:web` for the static site in `dist-web/`. The hosted app is at https://grandlime-labs.github.io/exit-ramp/ (GitHub Pages, deployed from `main` by `.github/workflows/pages.yml` with Vite base `/exit-ramp/`). You can also host `dist-web/` on Cloudflare Pages or any static host. Scanning and converting happen in the browser. The CSP (`default-src 'none'; script-src 'self'; connect-src https://api.val.town; …`) allows one outbound host: the Val Town API, used only by the optional exporter tab with a token you paste. The analyzer (ts-morph, about 7 MB, 1.6 MB gzipped) is loaded when you first press Scan.

## What it converts

Full table with sources: [docs/MAPPINGS.md](docs/MAPPINGS.md). Each finding is `auto` (should behave the same), `review` (converted, but behavior differs somewhere), `manual` (not converted, or converted to code that throws), or `info`.

| From | To | Notes |
|---|---|---|
| `Deno.serve(handler)` | exported handler wired into a Workers `fetch()` | Serve options are ignored; the second `info` argument is shimmed. |
| `Deno.cron(name, schedule, fn)` | `scheduled()` + `[triggers] crons` | UTC on both sides. Numeric weekdays become `MON`..`SUN` because **Cloudflare numbers weekdays 1=Sunday**. No automatic retries (`backoffSchedule`). |
| `Deno.env.get/has/toObject` | `env` from `cloudflare:workers` | Names go into `src/env.d.ts` and `.dev.vars.example`. |
| Deno KV | Workers KV through a Deno-KV-shaped helper | **Eventually consistent**, no atomic `check()`, no versionstamps, 1 write/sec/key. Tuple keys are encoded to sort the same way; `migrate/deno-kv-export.ts` moves your data. `atomic().check()` throws instead of pretending. |
| `npm:` `jsr:` `https://esm.sh` and friends | `package.json` dependencies | `jsr:` goes through JSR's npm registry (`.npmrc` generated). `deno.json` import maps are read. |
| Val Town HTTP / cron / email vals | `fetch()` / `scheduled()` / `email()` | Email uses `postal-mime` to rebuild Val Town's `Email` shape. `interval.lastRunAt` is kept in KV. |
| `std/sqlite` | D1 (binding `DB`) | Named params rewritten; rows are plain objects; `batch()` is one transaction. |
| `std/blob` | R2 (binding `BLOB`) | `get` returns a `Response`; missing keys throw. |
| `std/email` | Cloudflare Email Service (binding `EMAIL`) | Needs an onboarded domain and sender. |
| `std/openai`, `std/utils`, `esm.town/v/user/val`, `deno.land/x` | flagged `manual` with advice | No safe drop-in exists. |
| Leftover `Deno.*` (fs, exit, Command, listen, …) | flagged `manual` | Each has a specific explanation. |

### Confidence score

A file starts at 100 and loses 22 per `manual` and 8 per `review` finding (`auto` and `info` are free). 85+ is *high*, 60-84 *medium*, below 60 *low*. The project score is the mean, capped at the worst file + 25 so one broken file is never averaged away. It is a triage number, not a guarantee.

## How it is tested

```bash
npm run ci          # gen:check, typecheck, tests, build
npm run verify      # convert the fixtures, typecheck them against @cloudflare/workers-types,
                    # run them under `wrangler dev --local` and call the endpoints
npm run smoke:web   # headless Chrome against the built web app (needs Chrome; set CHROME_PATH)
node scripts/verify.mjs --install   # also `npm install` each generated project from the registry
```

- **Unit/integration (vitest):** every rule, the cron and key codecs (property tests against Deno's tuple order), the KV/D1/R2 helpers against real workerd through miniflare, the CLI, the exporter against a local mock of the Val Town API, the Action's shell step, and report formats.
- **verify:** the converted fixtures really run: KV counters and ordered `list()`, D1 inserts with named parameters, R2 blobs, cron jobs matched by schedule, `lastRunAt` persisted between runs, and an email val fed through `/cdn-cgi/handler/email`. The Node target is started and fetched too.

## Limitations (read before you rely on it)

- It cannot know your runtime behavior. It rewrites known patterns and flags the rest; a high score means "few known problems", not "works".
- Workers KV is not Deno KV. If you depend on strong consistency or `atomic().check()`, move that data to a Durable Object or D1.
- Val Town cron schedules and secret values are not available from its API.
- `std/email` needs a sender domain on Cloudflare. A local run proves the binding is wired, not that mail is delivered.
- Vals that import other vals (`esm.town/v/user/val`) must be copied in by hand.
- Filesystem access, `Deno.Command` and sockets through `Deno.*` are flagged `manual`. Static-file serving (`std/utils` helpers, Hono `serveStatic`, `node:fs` reads) is only covered by the `std/utils` advice: check those routes by hand and move assets to Workers Static Assets.
- The Node target is secondary: HTTP and cron work; KV, sqlite, blob and email are flagged `manual`.
- Two or more HTTP vals in one project cannot share one Worker `fetch()`: the first is wired and the rest are listed.
- Tested against wrangler 4.160 / workerd 2026-11-10 and TypeScript 7. The generated `compatibility_date` is `2026-10-01` by default; an older installed workerd will refuse a date it does not know (use `--compat-date`).

## Pricing

The scan is free everywhere (CLI, web, Action). A paid "convert" tier is *designed* but **not built**: no payments, accounts or license checks exist in this repo. See [docs/PRICING-DESIGN.md](docs/PRICING-DESIGN.md).

## npm package

The CLI is published as the free public package [`exit-ramp`](https://www.npmjs.com/package/exit-ramp) (`npx exit-ramp`). The tarball is the bundled CLI, README, and LICENSE; `prepack` rebuilds the CLI. The GitHub Action still builds from this repo's source and does not need the npm package.

See `CHANGELOG.md` for release notes.

## License

MIT. Not affiliated with Val Town, Deno or Cloudflare.
