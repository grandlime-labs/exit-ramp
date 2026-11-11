// End-to-end verification: convert each fixture with the BUILT CLI, typecheck the result against
// @cloudflare/workers-types, then run it under `wrangler dev --local` (workerd, no account, no network) and hit it.
// Usage: node scripts/verify.mjs [--only name] [--install]   (run `npm run build:cli` first)
//   --install  additionally run `npm install` inside each generated project to prove its package.json resolves (needs network)
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
const install = args.includes("--install");
const cli = join(root, "dist/cli.mjs");
if (!existsSync(cli)) {
  console.error("dist/cli.mjs missing: run `npm run build:cli`");
  process.exit(1);
}

const realFetch = globalThis.fetch;
globalThis.fetch = (u, o = {}) => realFetch(u, { signal: AbortSignal.timeout(20000), ...o });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? "  -> " + detail : ""}`);
};

function run(cmd, argv, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, argv, { cwd: opts.cwd ?? root, env: { ...process.env, WRANGLER_SEND_METRICS: "false", ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
}

function startServer(cmd, argv, opts) {
  const p = spawn(cmd, argv, { cwd: opts.cwd, env: { ...process.env, WRANGLER_SEND_METRICS: "false", ...opts.env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const proc = { p, out: "" };
  p.stdout.on("data", (d) => (proc.out += d));
  p.stderr.on("data", (d) => (proc.out += d));
  proc.stop = () => {
    try {
      process.kill(-p.pid, "SIGKILL");
    } catch {}
  };
  return proc;
}

async function waitFor(url, proc, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      await r.arrayBuffer();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
    if (proc.p.exitCode !== null) return false;
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROJECTS = [
  {
    name: "valtown-app",
    fixture: "valtown-app",
    target: "workers",
    cron: ["digest.cron.ts=0 9 * * 1"],
    devVars: "API_SECRET=s3cret\nEXIT_RAMP_EMAIL_FROM=app@example.com\nEXIT_RAMP_EMAIL_TO=me@example.com\n",
    async scenario(base, proc) {
      let r = await fetch(base + "/");
      check("valtown-app: HTTP val GET /", r.status === 200 && (await r.text()) === "valtown-app ok");
      r = await fetch(base + "/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Hello World!", body: "first" }) });
      const created = await r.json().catch(() => ({}));
      check("valtown-app: std/sqlite -> D1 insert (named args) + std/blob -> R2 setJSON", r.status === 201 && created.slug === "hello-world", `${r.status} ${JSON.stringify(created)}`);
      r = await fetch(base + "/notes/hello-world");
      const got = await r.json().catch(() => ({}));
      check("valtown-app: D1 select (positional args) + R2 getJSON", r.status === 200 && got.note?.body === "first" && got.meta?.title === "Hello World!", JSON.stringify(got));
      r = await fetch(base + "/raw/hello-world");
      check("valtown-app: blob.get returns a Response with stored content-type", r.status === 200 && r.headers.get("content-type") === "application/json" && (await r.json()).body === "first");
      r = await fetch(base + "/raw/nope");
      check("valtown-app: blob.get on a missing key throws (-> 404 here)", r.status === 404);
      r = await fetch(base + "/secret");
      check("valtown-app: Deno.env.get -> env binding", (await r.text()) === "s3cret");
      r = await fetch(base + "/notify", { method: "POST" });
      const note = await r.text();
      check("valtown-app: std/email -> send_email binding reached (local simulator)", r.status === 200, `${r.status} ${note.slice(0, 200)}`);
      // cron: first run has no lastRunAt, second run must see one (stored in KV)
      let s = await fetch(base + "/__scheduled?cron=" + encodeURIComponent("0 9 * * MON"));
      await s.text();
      await sleep(300);
      s = await fetch(base + "/__scheduled?cron=" + encodeURIComponent("0 9 * * MON"));
      await s.text();
      await sleep(500);
      const sinces = [...proc.out.matchAll(/digest \{ since: (\d+)/g)].map((m) => Number(m[1]));
      check("valtown-app: cron val runs via scheduled(); lastRunAt persisted in KV", sinces.length >= 2 && sinces[0] === 0 && sinces[1] > 1e12, JSON.stringify(sinces));
      // email val: Email Worker handler
      const raw = "From: Alice <alice@example.com>\r\nTo: bot@example.com\r\nSubject: Hello bot\r\nMessage-ID: <1@example.com>\r\nContent-Type: text/plain\r\n\r\nthe body\r\n";
      const er = await fetch(base + "/cdn-cgi/handler/email?from=alice%40example.com&to=bot%40example.com", { method: "POST", body: raw });
      await er.text();
      await sleep(500);
      const inbox = await (await fetch(base + "/inbox")).json().catch(() => []);
      check("valtown-app: email val -> email() handler (postal-mime) -> blob", er.status === 200 && Array.isArray(inbox) && inbox.length === 1, `${er.status} ${JSON.stringify(inbox)}`);
    },
  },
  {
    name: "deno-app",
    fixture: "deno-app",
    target: "workers",
    devVars: "API_SECRET=abc\n",
    async scenario(base, proc) {
      let r = await fetch(base + "/");
      check("deno-app: Deno.serve -> fetch + jsr:@std/path via npm alias", r.status === 200 && (await r.text()) === "deno-app ok a/b");
      await fetch(base + "/hit/home");
      r = await fetch(base + "/hit/home");
      check("deno-app: Deno.openKv get/set -> Workers KV", (await r.json()).n === 2);
      await fetch(base + "/users/5", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "five" }) });
      await fetch(base + "/users/12", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "twelve" }) });
      r = await fetch(base + "/users");
      const users = await r.json();
      check("deno-app: tuple keys sort numerically (12 after 5), list reverse + prefix", users.map((u) => u.id).join(",") === "12,5", JSON.stringify(users));
      r = await fetch(base + "/pair", { method: "POST" });
      check("deno-app: atomic() without check commits", (await r.json()).ok === true);
      r = await fetch(base + "/env");
      check("deno-app: Deno.env.get", (await r.text()) === "abc");
      const before = proc.out.length;
      await (await fetch(base + "/__scheduled?cron=" + encodeURIComponent("*/20 * * * *"))).text();
      await (await fetch(base + "/__scheduled?cron=" + encodeURIComponent("0 3 * * MON-FRI"))).text();
      await sleep(400);
      const log = proc.out.slice(before);
      check("deno-app: Deno.cron jobs matched by schedule (only the matching job runs)", log.includes("sync") && log.includes("cleanup") && !log.includes("weekly"), log.slice(-300));
    },
  },
  {
    name: "deno-simple",
    fixture: "deno-simple",
    target: "workers",
    devVars: "GREETING=howdy\n",
    async scenario(base, proc) {
      const r = await fetch(base + "/hello");
      check("deno-simple (workers): Deno.serve + Deno.env", (await r.text()) === "howdy from /hello");
      const before = proc.out.length;
      await (await fetch(base + "/__scheduled?cron=" + encodeURIComponent("*/5 * * * *"))).text();
      await sleep(300);
      check("deno-simple (workers): single cron runs", proc.out.slice(before).includes("tick"));
    },
  },
  {
    name: "deno-simple-node",
    fixture: "deno-simple",
    target: "node",
    env: { GREETING: "hi" },
    async scenario(base) {
      const r = await fetch(base + "/hello");
      check("deno-simple (node target): Deno.serve -> node:http, Deno.env -> process.env", (await r.text()) === "hi from /hello");
      const h = await fetch(base + "/health");
      check("deno-simple (node target): /health", (await h.text()) === "ok");
    },
  },
];

let port = 8800 + Math.floor(Math.random() * 400);

for (const proj of PROJECTS) {
  if (only && only !== proj.name) continue;
  console.log(`\n== ${proj.name} (${proj.target})`);
  const out = join(root, "out/verify", proj.name);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(dirname(out), { recursive: true });
  const cronArgs = (proj.cron ?? []).flatMap((c) => ["--cron", c]);
  const conv = await run("node", [cli, "convert", join(root, "fixtures", proj.fixture), "--out", out, "--target", proj.target, "--name", proj.name, ...cronArgs]);
  check(`${proj.name}: convert`, conv.code === 0, conv.out.slice(-500));
  if (conv.code !== 0) continue;

  // with --install the generated project's own freshly installed tools are used; otherwise the repo's
  const bin = (n) => (install && existsSync(join(out, "node_modules/.bin", n)) ? join(out, "node_modules/.bin", n) : join(root, "node_modules/.bin", n));
  if (install) {
    const ins = await run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts"], { cwd: out });
    check(`${proj.name}: generated package.json installs from the registry`, ins.code === 0, ins.out.slice(-800));
  }
  const tsc = await run(bin("tsc"), ["--noEmit", "-p", out]);
  check(`${proj.name}: tsc --noEmit (${proj.target === "workers" ? "@cloudflare/workers-types" : "@types/node"})`, tsc.code === 0, tsc.out.slice(0, 1500));

  port += 2;
  const base = `http://127.0.0.1:${port}`;
  let proc;
  if (proj.target === "workers") {
    if (proj.devVars) writeFileSync(join(out, ".dev.vars"), proj.devVars);
    proc = startServer(bin("wrangler"), ["dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(port + 1), "--test-scheduled", "--persist-to", join(out, ".state")], { cwd: out });
  } else {
    proc = startServer(bin("tsx"), ["src/server.ts"], { cwd: out, env: { PORT: String(port), ...proj.env } });
  }
  const ready = await waitFor(base + "/", proc);
  check(`${proj.name}: ${proj.target === "workers" ? "wrangler dev --local" : "node server"} starts`, ready, proc.out.slice(-1500));
  if (ready) {
    try {
      await proj.scenario(base, proc);
    } catch (e) {
      check(`${proj.name}: scenario`, false, String(e?.stack ?? e));
    }
  }
  proc.stop();
  await sleep(500);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("\nFAILED:");
  for (const f of failed) console.log(`- ${f.name}\n${f.detail}\n`);
}
writeFileSync(join(root, "out/verify-results.json"), JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
