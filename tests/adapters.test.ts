// Runs the generated helpers (templates/*.ts) against real workerd-backed KV, D1 and R2 through miniflare.
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env as workersEnv } from "cloudflare:workers";
import { blob, BlobNotFoundError } from "../templates/blob";
import { ExitRampKvUnsupportedError, openKv } from "../templates/kv";
import { getLastRun, setLastRun } from "../templates/last-run";
import { sqlite, toPositional } from "../templates/sqlite";

const env = workersEnv as unknown as Record<string, unknown>;
let mf: Miniflare;
beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", compatibilityDate: "2026-08-01", kvNamespaces: ["KV"], d1Databases: ["DB"], r2Buckets: ["BLOB"] });
  await mf.ready;
  env.KV = await mf.getKVNamespace("KV");
  env.DB = await mf.getD1Database("DB");
  env.BLOB = await mf.getR2Bucket("BLOB");
});
afterAll(async () => {
  await mf?.dispose();
});

describe("Deno KV adapter over Workers KV", () => {
  beforeEach(async () => {
    const ns = env.KV as KVNamespace;
    const all = await ns.list();
    await Promise.all(all.keys.map((k) => ns.delete(k.name)));
  });

  it("get/set/delete with tuple keys; missing keys return value null", async () => {
    const kv = await openKv();
    expect((await kv.get(["a", 1])).value).toBeNull();
    const res = await kv.set(["a", 1], { x: new Date(1000), y: [1n] });
    expect(res.ok).toBe(true);
    const got = await kv.get<{ x: Date; y: bigint[] }>(["a", 1]);
    expect(got.value?.x).toEqual(new Date(1000));
    expect(got.value?.y).toEqual([1n]);
    expect(got.versionstamp).toBeNull(); // documented difference
    await kv.delete(["a", 1]);
    expect((await kv.get(["a", 1])).value).toBeNull();
  });

  it("getMany keeps order", async () => {
    const kv = await openKv();
    await kv.set(["k", 1], "one");
    await kv.set(["k", 2], "two");
    const r = await kv.getMany([["k", 2], ["k", 9], ["k", 1]]);
    expect(r.map((e) => e.value)).toEqual(["two", null, "one"]);
  });

  it("list by prefix returns keys in Deno tuple order (numbers numerically), with limit, reverse and range", async () => {
    const kv = await openKv();
    for (const id of [100, 5, 12, 1]) await kv.set(["users", id], { id });
    await kv.set(["usersX", 1], "sibling");
    await kv.set(["other", 1], "x");
    const ids = async (sel: Parameters<typeof kv.list>[0], opts?: Parameters<typeof kv.list>[1]) => {
      const out: unknown[] = [];
      for await (const e of kv.list(sel, opts)) out.push(e.key[1]);
      return out;
    };
    expect(await ids({ prefix: ["users"] })).toEqual([1, 5, 12, 100]);
    expect(await ids({ prefix: ["users"] }, { reverse: true })).toEqual([100, 12, 5, 1]);
    expect(await ids({ prefix: ["users"] }, { limit: 2 })).toEqual([1, 5]);
    expect(await ids({ prefix: ["users"], start: ["users", 5], end: ["users", 100] })).toEqual([5, 12]);
    expect(await ids({ start: ["users", 5], end: ["users", 100] })).toEqual([5, 12]);
  });

  it("atomic() without checks applies all mutations", async () => {
    const kv = await openKv();
    const r = await kv.atomic().set(["p", "a"], 1).set(["p", "b"], 2).delete(["p", "a"]).commit();
    expect(r.ok).toBe(true);
    expect((await kv.get(["p", "a"])).value).toBeNull();
    expect((await kv.get(["p", "b"])).value).toBe(2);
  });

  it("atomic().check() throws loudly instead of pretending to be atomic", async () => {
    const kv = await openKv();
    await expect(kv.atomic().check({ key: ["l"], versionstamp: null }).set(["l"], 1).commit()).rejects.toBeInstanceOf(ExitRampKvUnsupportedError);
  });

  it("unsafeBestEffortChecks: versionstamp null means must-not-exist", async () => {
    const kv = await openKv({ unsafeBestEffortChecks: true });
    expect((await kv.atomic().check({ key: ["l"], versionstamp: null }).set(["l"], 1).commit()).ok).toBe(true);
    expect((await kv.atomic().check({ key: ["l"], versionstamp: null }).set(["l"], 2).commit()).ok).toBe(false);
    expect((await kv.get(["l"])).value).toBe(1);
  });

  it("queues, watch, sum/min/max throw", async () => {
    const kv = await openKv();
    expect(() => kv.enqueue()).toThrow(ExitRampKvUnsupportedError);
    expect(() => kv.listenQueue()).toThrow(ExitRampKvUnsupportedError);
    expect(() => kv.watch()).toThrow(ExitRampKvUnsupportedError);
    expect(() => kv.atomic().sum()).toThrow(ExitRampKvUnsupportedError);
  });

  it("expireIn below 60s is clamped to Workers KV's minimum instead of failing", async () => {
    const kv = await openKv();
    await expect(kv.set(["t"], 1, { expireIn: 1000 })).resolves.toMatchObject({ ok: true });
  });

  it("openKv ignores a path argument", async () => {
    await expect(openKv("./data.db")).resolves.toBeDefined();
  });
});

describe("toPositional", () => {
  it("rewrites named params to numbered and reuses repeated names", () => {
    expect(toPositional("SELECT * FROM t WHERE a = :a OR b = @b OR c = :a", { a: 1, b: 2 })).toEqual({ sql: "SELECT * FROM t WHERE a = ?1 OR b = ?2 OR c = ?1", params: [1, 2] });
  });
  it("leaves strings, comments and casts alone", () => {
    const sql = "SELECT ':a', \"@b\" -- :c\n, x::int /* $d */ FROM t WHERE y = :y";
    const r = toPositional(sql, { y: 1 });
    expect(r.sql).toContain("':a'");
    expect(r.sql).toContain("-- :c");
    expect(r.sql).toContain("/* $d */");
    expect(r.sql.endsWith("= ?1")).toBe(true);
  });
  it("passes positional arrays through and converts booleans, dates, undefined", () => {
    const d = new Date(0);
    expect(toPositional("INSERT INTO t VALUES (?,?,?,?)", [true, d, undefined, 5n]).params).toEqual([1, d.toISOString(), null, 5]);
  });
  it("reports missing named parameters", () => {
    expect(() => toPositional("SELECT :a, :b", { a: 1 })).toThrow(/b/);
  });
});

describe("std/sqlite facade over D1", () => {
  it("execute: DDL, insert with named args, select shape, rowsAffected, lastInsertRowid", async () => {
    await sqlite.execute("CREATE TABLE IF NOT EXISTS t1 (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, n REAL)");
    const ins = await sqlite.execute({ sql: "INSERT INTO t1 (name, n) VALUES (:name, :n)", args: { name: "a", n: 1.5 } });
    expect(ins.rowsAffected).toBe(1);
    expect(Number(ins.lastInsertRowid)).toBeGreaterThan(0);
    const sel = await sqlite.execute({ sql: "SELECT id, name, n FROM t1 WHERE name = ?", args: ["a"] });
    expect(sel.columns).toEqual(["id", "name", "n"]);
    expect(sel.rows[0]).toMatchObject({ name: "a", n: 1.5 });
  });
  it("empty select still reports column names", async () => {
    const sel = await sqlite.execute("SELECT id, name FROM t1 WHERE 1 = 0");
    expect(sel.rows).toEqual([]);
    expect(sel.columns).toEqual(["id", "name"]);
  });
  it("multi-statement strings run through exec", async () => {
    await sqlite.execute("CREATE TABLE IF NOT EXISTS t2 (a); INSERT INTO t2 VALUES (1); INSERT INTO t2 VALUES (2);");
    expect((await sqlite.execute("SELECT count(*) AS c FROM t2")).rows[0]).toMatchObject({ c: 2 });
  });
  it("a semicolon inside a string literal is not multi-statement", async () => {
    await sqlite.execute({ sql: "INSERT INTO t1 (name) VALUES (?)", args: ["x;y"] });
    const r = await sqlite.execute("SELECT name FROM t1 WHERE name = 'x;y'");
    expect(r.rows).toHaveLength(1);
  });
  it("batch is transactional: a failing statement rolls back the earlier ones", async () => {
    await sqlite.execute("CREATE TABLE IF NOT EXISTS t3 (id INTEGER PRIMARY KEY)");
    await expect(sqlite.batch(["INSERT INTO t3 VALUES (1)", "INSERT INTO t3 VALUES (1)"])).rejects.toThrow();
    expect((await sqlite.execute("SELECT count(*) AS c FROM t3")).rows[0]).toMatchObject({ c: 0 });
    const ok = await sqlite.batch([{ sql: "INSERT INTO t3 VALUES (:i)", args: { i: 7 } }, "SELECT * FROM t3"]);
    expect(ok[1].rows).toHaveLength(1);
  });
});

describe("std/blob facade over R2", () => {
  it("set/get/getJSON/list/copy/move/delete", async () => {
    await blob.set("a/one.txt", "hello");
    const res = await blob.get("a/one.txt");
    expect(await res.text()).toBe("hello");
    await blob.setJSON("a/two.json", { n: 2 });
    expect(await blob.getJSON("a/two.json")).toEqual({ n: 2 });
    expect(await blob.getJSON("a/missing.json")).toBeUndefined();
    expect((await blob.list("a/")).map((x) => x.key)).toEqual(["a/one.txt", "a/two.json"]);
    await blob.copy("a/one.txt", "b/copy.txt");
    await blob.move("b/copy.txt", "b/moved.txt");
    expect((await blob.list("b/")).map((x) => x.key)).toEqual(["b/moved.txt"]);
    await blob.delete("b/moved.txt");
    expect(await blob.list("b/")).toEqual([]);
  });
  it("get on a missing key throws BlobNotFoundError", async () => {
    await expect(blob.get("nope")).rejects.toBeInstanceOf(BlobNotFoundError);
  });
  it("accepts binary bodies", async () => {
    await blob.set("bin", new Uint8Array([1, 2, 3]));
    expect(new Uint8Array(await (await blob.get("bin")).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("last-run store", () => {
  it("returns undefined first, then the stored time", async () => {
    expect(await getLastRun("job.cron.ts")).toBeUndefined();
    await setLastRun("job.cron.ts", 1_700_000_000_000);
    expect((await getLastRun("job.cron.ts"))?.toISOString()).toBe(new Date(1_700_000_000_000).toISOString());
  });
});
