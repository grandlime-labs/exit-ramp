# LAUNCH.md: drafts only

**Nothing in this file has been posted.** Every item is a draft for a human to read, edit and post themselves. Replace `{{URL}}` with the real repo or site URL once it exists (nothing has been published, so no URL exists yet).

Timing matters: Val Town announced its wind-down on 2026-11-10 and the Hacker News thread (item 50443427) is live now. Replies are most useful in the first day or two.

---

## 0. Facts you may use (each verified against the source named)

| Fact | Source |
|---|---|
| Val Town is winding down. New signups and plan upgrades ended 2026-11-10. | <https://blog.val.town/winding-down> |
| Read-only mode starts 2026-12-10 (not including sqlite and blob storage); all other services end 2027-01-10; Val Town is to be open-sourced 2027-02-01. | same |
| Val Town's own guides cover migrating to Cloudflare, Vercel, Netlify, Render and GitHub; they recommend LLM-assisted migration. | <https://docs.val.town/migration> |
| Deno announced it is joining Cloudflare on 2026-10-09; Deno Deploy shuts down after six months; the runtime is maintained until October 2027. | <https://deno.com/blog/cloudflare> |
| `denoland/deno#37030` ("The state of Deno after the Cloudflare announcement"): monthly 2.9.x LTS releases with bug and security fixes until October 2027, no new feature work, forks allowed (MIT). | <https://github.com/denoland/deno/issues/37030> |
| Cloudflare Cron Triggers use UTC and number weekdays 1 = Sunday … 7 = Saturday. | <https://developers.cloudflare.com/workers/configuration/cron-triggers/> |
| Workers KV is eventually consistent (changes can take 60 s or more to appear elsewhere) and has no atomic/transaction support. | <https://developers.cloudflare.com/kv/concepts/how-kv-works/> |

## Facts about exit-ramp you may use (verified by running it in this repo)

- Scan is free and read-only (CLI, web app, GitHub Action). The web app runs in the browser; code is not uploaded.
- Converted fixture projects typecheck against `@cloudflare/workers-types` and run under `wrangler dev --local`; HTTP, cron, email handlers, KV, D1 and R2 behavior was checked by calling them.
- The Node target is secondary and covers HTTP and cron only.
- It flags what it cannot convert. It does not claim a converted app works in production.

## Do **not** claim

- Any number of users, downloads, stars, conversions or "hours saved". None exist.
- "Zero-config", "one click" or "100% automatic". Manual items are normal.
- That it migrates data, secrets or DNS. It does not.
- That Workers KV is a drop-in for Deno KV.
- That it is endorsed by or affiliated with Val Town, Deno or Cloudflare.
- That Lemon Squeezy or anything else is live. No payment exists.

---

## 1. Landing page copy

**Headline:** Moving off Val Town or Deno Deploy? Find out what breaks before you start.

**Subhead:** exit-ramp scans your project, scores every file, and builds a Cloudflare Workers project from what it can convert safely. It tells you plainly what it can't. The scan is free and runs in your browser.

**Three points**

1. **Scan first.** Paste a val or drop a folder. You get a confidence score per file and a short list of the things that need a human: Deno KV consistency, atomic checks, cron weekday numbering, `std/*` modules with no equivalent.
2. **Convert with a paper trail.** Deno.serve, Deno.cron, Deno.env, Deno KV, `std/sqlite`, `std/blob`, `std/email` and Val Town HTTP, cron and email vals become Worker entry points, bindings and a `wrangler.toml`. Every change has a rule and a doc link in `MIGRATION_REPORT.md`.
3. **Nothing is uploaded.** The web app runs in your tab under a strict content security policy. The CLI and GitHub Action run on your machine or your runner.

**How it works:** parse with ts-morph, apply a fixed set of rewrite rules, report per-file confidence, generate `wrangler.toml`, `package.json` and typed bindings. Same input, same output.

**The dates:** Val Town's code becomes read-only on 2026-12-10 and its services stop on 2027-01-10. Deno Deploy shuts down about six months after the 2026-10-09 announcement.

**What it won't do:** move your data or secrets, change DNS, port the code that has no equivalent (`std/openai`, `std/utils`, vals that import other vals), or promise your app behaves the same. Workers KV is not Deno KV, and we say where.

**FAQ**
- *Is it free?* The scan is, and the code is MIT. Hosted conversion with a human review may become a paid option; there is no checkout today.
- *Can't I just ask an AI agent?* Yes, and Val Town's guide suggests it. exit-ramp is the deterministic part: repeatable output, an explicit list of differences, and tests. Use both: let the report tell your agent what is left.
- *Does it support Val Town cron schedules?* The Val Town API does not expose them, so you provide them with `--cron` or a config file.
- *Other targets?* Cloudflare Workers first. Node is a secondary target for HTTP and cron.

**Call to action:** Scan your project (free) → {{URL}}

---

## 2. Show HN

**Title (≤80 chars):**
`Show HN: Exit-ramp – scan and convert Val Town / Deno Deploy code to Workers`

**URL:** the GitHub repo (or the hosted web app) {{URL}}

**First comment (post immediately after submitting):**

> Val Town announced it is winding down (read-only 2026-12-10, services off 2027-01-10), and Deno Deploy is going away about six months after the Cloudflare announcement, so a lot of small vals and Deno scripts need a new home. Both platforms point at Cloudflare Workers as a target, so I wrote a tool for the mechanical part.
>
> What it does: you give it a folder (or paste a val). It parses the code with ts-morph and reports, per file, what converts cleanly, what converts with a behavior change, and what it can't convert. Then it can generate a Workers project: `Deno.serve` -> `fetch()`, `Deno.cron` -> `scheduled()` + cron triggers, `Deno.env` -> bindings, Val Town HTTP/cron/email vals -> Worker entry points, `std/sqlite` -> D1, `std/blob` -> R2, `jsr:`/`npm:`/esm.sh imports -> package.json.
>
> The part I care most about is honesty about the semantic gaps. Deno KV -> Workers KV is not a rename: Workers KV is eventually consistent and has no atomic `check()`, so `atomic().check()` is flagged and the helper throws rather than pretending. Keys become strings, so there's a key codec that sorts the same as Deno's tuple order (property-tested against a reference implementation). Cloudflare numbers cron weekdays 1=Sunday, so `0 9 * * 1-5` would silently mean Sun-Thu; exit-ramp rewrites numeric weekdays to names.
>
> How it was checked: unit tests per rule, the helpers run against real workerd via miniflare, and the converted fixtures are typechecked against @cloudflare/workers-types and run under `wrangler dev --local` (HTTP, cron, an email handler, KV/D1/R2). That shows the wiring works; it doesn't prove your app does.
>
> Limits: Val Town's API doesn't expose cron schedules or secret values, so you supply those. `std/openai`, `std/utils` and vals that import other vals are flagged manual. The Node target is secondary (HTTP + cron only). It doesn't migrate data or DNS.
>
> The scan is free and read-only: CLI, GitHub Action (job summary), and a static web app that runs entirely in the tab under a strict CSP. MIT licensed. I'd like to hear which patterns in your vals it misses.

(Do not ask for upvotes, and do not mention pricing in the first comment. HN's guidelines discourage promotional framing; the above is a description plus limits.)

---

## 3. Reply for the Val Town thread (HN item 50443427)

Post as a **top-level comment** or as a reply to the comment from `seanw265` that says agents can handle most of the migration. Read the thread again right before posting; if someone has already posted the same thing, do not repeat it.

> For anyone moving off to Cloudflare Workers (one of the targets in Val Town's own migration guides): I wrote an open-source scanner/converter for exactly this, {{URL}}. It's mechanical, not magic: it reads your vals, tells you per file what converts cleanly and what needs a human, and can generate a Workers project (HTTP/cron/email vals -> fetch/scheduled/email, std/sqlite -> D1, std/blob -> R2).
>
> Two things I learned that may save you an evening even if you don't use it: Cloudflare numbers cron weekdays 1=Sunday (unix is 0=Sunday), so a numeric `1-5` becomes Sun-Thu; and Val Town's API doesn't return cron schedules or secret values, so copy those out of the UI before it goes read-only on Dec 10.
>
> It doesn't move data or secrets and flags `std/openai`, `std/utils` and cross-val imports as manual. Scan is free and runs in the browser, nothing uploaded.

Notes: this is disclosed self-promotion, kept short and useful on its own. It does not criticise Val Town, other migration helpers in the thread, or anyone else. Do not argue with replies; answer factual questions once.

---

## 4. Reply for Deno issue #37030

`denoland/deno#37030` is a pinned, maintainer-written status thread ("The state of Deno after the Cloudflare announcement"). A promotional comment there is likely unwelcome. **Recommendation:** read the latest comments first. Post only if people are already asking about migrating Deno Deploy apps to Workers; otherwise skip it, or put this in a new GitHub Discussion or the Deno Discord instead.

If it fits, keep it to this:

> For people moving Deno Deploy apps to Workers while the LTS runs: I wrote a small open-source scanner, {{URL}}, that lists per file what maps cleanly (Deno.serve, Deno.cron, Deno.env, npm:/jsr: imports) and what doesn't. The big gap is Deno KV: Workers KV is eventually consistent and has no atomic `check()`, so those call sites are flagged rather than converted silently. It also converts cron weekdays, since Cloudflare numbers them 1=Sunday. Free and MIT; feedback on what it misses is welcome. Not affiliated with Deno or Cloudflare.

---

## 5. Three X posts

Each is ≤ 280 characters with the URL counted as 23 (X shortens links). Verified by a script (see the bottom of this file).

**Post 1: the news hook**
```
Val Town goes read-only Dec 10 and stops Jan 10. Deno Deploy shuts down ~6 months after the Cloudflare announcement.

exit-ramp scans a project, scores each file, lists what needs a human, then builds a Workers project. Free scan, MIT, runs locally. {{URL}}
```

**Post 2: the Deno KV gap**
```
Deno KV -> Workers KV is not a rename.

Workers KV: eventually consistent, no atomic check(), 1 write/sec/key, string keys.

exit-ramp flags each, ships a key codec that keeps Deno's tuple order, and makes atomic().check() throw instead of lying. {{URL}}
```

**Post 3: the cron gotcha**
```
Cron gotcha moving Deno.cron to Cloudflare: its weekdays count 1=Sunday, unix counts 0=Sunday.

"0 9 * * 1-5" quietly becomes Sun-Thu.

exit-ramp rewrites numeric weekdays to MON-FRI and tells you when it did. Free scan: {{URL}}
```

---

## 6. Before posting anything (manual checklist)

1. Create the public repo, push this directory, confirm CI is green on GitHub.
2. Host the static web app (Cloudflare Pages / GitHub Pages: see `docs/DEPLOY.md`) and open it in a fresh browser profile to check it loads under the CSP.
3. Replace every `{{URL}}`.
4. Run `npm run verify` and `npm run ci` once more on the final commit.
5. Tag `v1` so `uses: you/exit-ramp@v1` in the README works.
6. Reread the Val Town blog and the Deno blog for date changes. Update README, web banner and this file if they changed.
7. Post from your own account, by hand. Do not schedule replies in other people's threads.
8. Be ready to answer: "why not just use an AI agent?" (see the FAQ), "does it handle X?" (point at `docs/MAPPINGS.md`).

<!-- tweet length check: run `node scripts/check-launch.mjs` -->
