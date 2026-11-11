import { Hono } from "hono";
import { join } from "@std/path";
import { z } from "zod";

const kv = await Deno.openKv();
const app = new Hono();

const Counter = z.object({ n: z.number() });

app.get("/", (c) => c.text("deno-app ok " + join("a", "b")));

app.get("/hit/:page", async (c) => {
  const key = ["hits", c.req.param("page")];
  const cur = await kv.get<number>(key);
  const next = (cur.value ?? 0) + 1;
  await kv.set(key, next);
  return c.json(Counter.parse({ n: next }));
});

app.put("/users/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json();
  await kv.set(["users", id], { ...body, at: new Date() }, { expireIn: 3600_000 });
  return c.json({ ok: true });
});

app.get("/users", async (c) => {
  const out: unknown[] = [];
  for await (const e of kv.list<{ name?: string }>({ prefix: ["users"] }, { limit: 50, reverse: true })) out.push({ id: e.key[1], ...e.value });
  return c.json(out);
});

app.post("/pair", async (c) => {
  const res = await kv.atomic().set(["pair", "a"], 1).set(["pair", "b"], 2).commit();
  return c.json({ ok: res.ok });
});

app.get("/env", (c) => c.text(Deno.env.get("API_SECRET") ?? "none"));

Deno.serve({ port: 8000 }, app.fetch);
