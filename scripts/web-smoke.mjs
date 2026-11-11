// Headless-browser smoke test of the built web app (dist-web) under its strict CSP.
// Needs a Chrome/Chromium binary: set CHROME_PATH or install google-chrome. Run: npm run build:web && node scripts/web-smoke.mjs
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import { chromium } from "playwright-core";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const dist = join(root, "dist-web");
if (!existsSync(join(dist, "index.html"))) {
  console.error("dist-web missing: run `npm run build:web`");
  process.exit(1);
}
const chrome = process.env.CHROME_PATH ?? ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);
if (!chrome) {
  console.error("No Chrome found. Set CHROME_PATH.");
  process.exit(2);
}

// serve dist-web with the headers from public/_headers, like Cloudflare Pages / Netlify would
const headersFile = readFileSync(join(dist, "_headers"), "utf8");
const headers = Object.fromEntries(headersFile.split("\n").slice(1).map((l) => l.trim()).filter(Boolean).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const server = createServer((req, res) => {
  const path = normalize(new URL(req.url, "http://x").pathname).replace(/^(\.\.[/\\])+/, "");
  const file = join(dist, path === "/" || path === "\\" ? "index.html" : path);
  if (!file.startsWith(dist) || !existsSync(file)) return void res.writeHead(404).end("nf");
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", ...headers });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const results = [];
const check = (n, ok, d = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  -> " + d}`);
};

const browser = await chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ acceptDownloads: true });
const page = await ctx.newPage();
const problems = [];
const requests = [];
page.on("console", (m) => (m.type() === "error" || m.text().toLowerCase().includes("content security policy")) && problems.push(m.text()));
page.on("pageerror", (e) => problems.push(String(e)));
page.on("request", (r) => requests.push(r.url()));

try {
  const resp = await page.goto(base);
  const csp = resp.headers()["content-security-policy"] ?? "";
  check("CSP header is served and has no unsafe-inline / unsafe-eval", /default-src 'none'/.test(csp) && !/unsafe-/.test(csp), csp);
  const meta = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  check("CSP meta tag is present in the built html", !!meta && /script-src 'self'/.test(meta) && !/unsafe-/.test(meta), String(meta));

  await page.click("#paste-sample");
  await page.click("#paste-add");
  check("sample file is added", (await page.locator("#files li").count()) === 1);

  await page.click("#scan");
  await page.waitForSelector("#results:not([hidden])", { timeout: 60000 });
  const score = await page.locator(".score").innerText();
  check("scan renders a confidence score", /^\d+\/100$/.test(score), score);
  const findings = await page.locator("#findings li").allInnerTexts();
  check("scan shows the KV consistency review finding", findings.some((t) => /Deno KV -> Workers KV/.test(t)), findings.join("\n").slice(0, 400));
  check("scan shows the cron conversion (weekday names)", findings.some((t) => /MON-FRI/.test(t)));

  await page.click("#convert");
  const dl = await page.waitForEvent("download", { timeout: 60000 }).catch(() => null);
  check("convert triggers a .zip download", !!dl && /\.zip$/.test(dl.suggestedFilename()), String(dl?.suggestedFilename()));
  if (dl) {
    const path = await dl.path();
    const zip = unzipSync(new Uint8Array(readFileSync(path)));
    check("zip contains wrangler.toml, worker.ts and the report", ["wrangler.toml", "src/worker.ts", "MIGRATION_REPORT.md", "src/exit-ramp/kv.ts"].every((n) => n in zip), Object.keys(zip).join(","));
    check("zip wrangler.toml has the converted cron", strFromU8(zip["wrangler.toml"]).includes('crons = ["0 3 * * MON-FRI"]'));
  }

  // XSS: hostile file names and code must render as text
  await page.fill("#paste-name", "<img src=x onerror=window.__xss=1>.ts");
  await page.fill("#paste-code", `Deno.serve(() => new Response("<img src=x onerror=window.__xss=1>"));`);
  await page.click("#paste-add");
  await page.click("#scan");
  await page.waitForTimeout(1500);
  check("hostile file names and snippets are rendered as text, not HTML", (await page.evaluate(() => window.__xss)) === undefined && (await page.locator("#files img, #findings img").count()) === 0);

  // Val Town exporter in the browser, against a mocked api.val.town (route interception; no real network)
  const seen = [];
  await page.route("https://api.val.town/**", async (route) => {
    const req = route.request();
    seen.push(`${req.method()} ${new URL(req.url()).pathname} ${req.headers()["authorization"] ?? ""}`);
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization" };
    const u = new URL(req.url());
    const json = (o) => route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(o) });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { ...cors, "access-control-allow-methods": "GET" } });
    if (u.pathname === "/v2/me/vals") return json({ data: [{ id: "v1", name: "mailer", privacy: "private", author: { username: "me" } }], links: { self: u.href } });
    if (u.pathname.endsWith("/files")) return json({ data: [{ path: "tick.ts", type: "interval" }], links: { self: u.href } });
    if (u.pathname.endsWith("/files/content")) return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/octet-stream" }, body: "export default async function (i: Interval) { console.log(i.lastRunAt); }" });
    if (u.pathname.includes("environment_variables")) return json({ data: [{ key: "TOKEN" }], links: { self: u.href } });
    return route.fulfill({ status: 404, headers: cors, body: "{}" });
  });
  await page.click("#tab-vt");
  await page.fill("#vt-token", "tok_test_123");
  await page.click("#vt-go");
  await page.waitForFunction(() => /Downloaded/.test(document.getElementById("vt-status").textContent), null, { timeout: 15000 }).catch(() => {});
  check("val town exporter: only GET/OPTIONS to api.val.town, token as bearer, cron schedule prompt shown", seen.length >= 3 && seen.every((x) => /^(GET|OPTIONS) /.test(x)) && seen.some((x) => x.endsWith("Bearer tok_test_123")) && (await page.inputValue("#crons")).includes("tick.ts="), seen.join(" | "));
  check("val town exporter: token field is cleared after use", (await page.inputValue("#vt-token")) === "");
  await page.unroute("https://api.val.town/**");

  const beforeProbes = [...problems]; // everything after this point is a deliberate CSP probe

  // inline script injection is blocked by the CSP
  const blocked = await page.evaluate(() => {
    try {
      const s = document.createElement("script");
      s.textContent = "window.__inline = 1";
      document.body.append(s);
    } catch {}
    return window.__inline === undefined;
  });
  check("inline script is blocked by CSP", blocked);

  // network: no request left the origin except possibly api.val.town (not used here)
  const external = requests.filter((u) => !u.startsWith("https://api.val.town/") && !u.startsWith(base) && !u.startsWith("blob:") && !u.startsWith("data:"));
  check("no network requests left this origin while scanning and converting", external.length === 0, external.join(", "));

  // CSP forbids connecting anywhere but api.val.town
  const leak = await page.evaluate(() => fetch("https://example.com/").then(() => "sent", () => "blocked"));
  check("fetch to other hosts is blocked by connect-src", leak === "blocked", leak);

  // folder input: ts + binary + node_modules
  await page.click("#tab-folder");
  await page.setInputFiles("#folder-input", join(root, "fixtures/deno-app"));
  await page.waitForTimeout(500);
  check("folder input adds files", (await page.locator("#files li").count()) >= 5);

  check("no CSP violations or page errors during normal use", beforeProbes.length === 0, beforeProbes.join("\n"));
} catch (e) {
  check("smoke test ran to completion", false, String(e?.stack ?? e));
}
await browser.close();
server.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} web checks passed`);
process.exit(failed ? 1 : 0);
