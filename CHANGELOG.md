# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-11-10

### Changed

- First public npm release of the `exit-ramp` CLI (`npx exit-ramp`). The package is free, unscoped, and MIT-licensed. The published tarball contains only the bundled CLI, README, and LICENSE.

## [0.1.0] — 2026-11-10

Initial public release. Free, MIT-licensed, no paid tier.

### Added

- Scan a Val Town or Deno Deploy project and report, per file, what will move cleanly to Cloudflare Workers, what needs review, and what needs a human.
- Convert into a Worker project: `Deno.serve` → `fetch()`, `Deno.cron` → `scheduled()` plus cron triggers, `Deno.env` → bindings, Val Town HTTP/cron/email vals → Worker entry points, `std/sqlite` → D1, `std/blob` → R2, `jsr:`/`npm:`/esm.sh imports → `package.json`.
- Read-only Val Town exporter (`exit-ramp export`) that only makes GET requests.
- Static web app that runs in the browser, plus a read-only GitHub Action that posts a job summary.
- Test suite, fixture verification under `wrangler dev --local`, CI, and a GitHub Pages site.
