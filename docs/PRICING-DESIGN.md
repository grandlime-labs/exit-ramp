# Free scan, paid convert: design (nothing here is built)

**Status: design only.** This repo contains no payment code, no accounts, no license keys and no network calls to a billing service. `CONVERT_GATE` in `web/main.ts` is a disabled stub marking where a check would go. Do not wire anything up before reading "Open questions".

## Why this split

The scan answers the question people have first ("how bad is it?") and is the best advertisement: it is free, read-only and runs locally. The value people will pay for is saved effort and lower risk on the *convert* step, in a window with a hard deadline (Val Town's code goes read-only 2026-12-10 and its services stop 2027-01-10; Deno Deploy shuts down about six months after 2026-10-09).

## What is free (forever, MIT)

- `exit-ramp scan` in the CLI, the web app and the GitHub Action, including the confidence report.
- The full source, including `convert`. See "Honest note on gating".

## What could be paid (hypotheses to test, not decisions)

| Offer | What the customer gets | Who it is for |
|---|---|---|
| **Convert pack** (one project) | Hosted web convert with the zip download, a reviewed `MIGRATION_REPORT.md`, and a human pass over the `MANUAL` items by the maintainer | Someone with 1 to 5 vals and no time |
| **Team / agency pack** | Same, for many vals, plus a verification checklist per val | Consultants migrating clients |
| **Done-for-you migration** | The maintainer ports the manual items and verifies on the customer's Cloudflare account | Businesses with revenue-bearing apps |

Prices are deliberately not set here: pick test prices after talking to five or ten real Val Town / Deno Deploy users. Do not invent a price from a competitor's page.

## Honest note on gating

The code is MIT. Anyone can run `convert` from source, so a technical gate on the CLI would be cosmetic and annoying. The defensible things to sell are **convenience** (hosted, no setup), **assurance** (a human reviewed the output) and **done-for-you work**. So:

- Keep `convert` working in the CLI.
- If the web app gates anything, gate the *hosted download*, not the logic, and say so plainly.
- Never show a fake countdown or fake scarcity. The real deadlines are the platform dates.

## Checkout: Lemon Squeezy (intended)

- Lemon Squeezy is a merchant of record: it sells on your behalf and handles sales tax/VAT collection. Verify the current terms yourself.
- **Bahamas payouts:** Lemon Squeezy's own [supported countries page](https://docs.lemonsqueezy.com/help/getting-started/supported-countries) lists the Bahamas under bank payouts (checked 2026-11-10). A third-party review warns that a country being on that list does not guarantee the bank option is enabled in every account, so confirm under *Settings -> Payout* when you sign up, before you build anything around it. That Stripe does not support the Bahamas is your note; it was not verified here.
- Payouts are made in USD (a bank payout can be converted to your chosen currency). Net sales are held 13 days before becoming payable ([getting paid docs](https://docs.lemonsqueezy.com/help/getting-started/getting-paid)). Check the current fee schedule on their site; fees quoted by third parties were not verified.

## If you build it later (sketch)

1. Create a Lemon Squeezy store and one product per offer. (Needs an account: not done.)
2. A hosted checkout link on the landing page. No custom payment form, no card data ever touches this code.
3. Fulfillment, simplest first: Lemon Squeezy emails a license key; the web app checks the key with a tiny Cloudflare Worker that calls the Lemon Squeezy license API. The key is the only thing stored client-side, in memory.
4. Webhooks (`order_created`, `order_refunded`) verified by signature, into a Worker + D1 table of valid keys. Only needed if keys must be revocable.
5. Refund policy and terms page before the first sale.

## Open questions (answer before building)

- Will anyone pay? Test with a manual offer first: "send me your val, I will send a report and a converted zip for $X" and count replies. No code needed.
- Does the Val Town shutdown window leave enough time to sell? It ends 2027-01-10; building payments takes days. Manual invoicing may be the faster test.
- Support load: every paid conversion creates support. Decide the limit of "done for you" up front.
- Tax and legal: merchant-of-record helps with sales tax but not with your own income reporting or business registration. Get advice for your jurisdiction.
- Naming/trademark: "exit-ramp" is generic. Check for conflicts before buying a domain.
