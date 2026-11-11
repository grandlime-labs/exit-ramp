import { Hono } from "https://esm.sh/hono@4.6.0";
import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";
import { blob } from "https://esm.town/v/std/blob?v=14";
import { email } from "https://esm.town/v/std/email";
import { slugify } from "./lib.ts";

const app = new Hono();

async function init() {
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE, body TEXT)`);
}

app.get("/", (c) => c.text("valtown-app ok"));

app.post("/notes", async (c) => {
  await init();
  const { title, body } = await c.req.json<{ title: string; body: string }>();
  const slug = slugify(title);
  await sqlite.execute({ sql: "INSERT INTO notes (slug, body) VALUES (:slug, :body)", args: { slug, body } });
  await blob.setJSON(`notes/${slug}.json`, { title, body, at: Date.now() });
  return c.json({ slug }, 201);
});

app.get("/notes/:slug", async (c) => {
  await init();
  const rs = await sqlite.execute({ sql: "SELECT slug, body FROM notes WHERE slug = ?", args: [c.req.param("slug")] });
  if (!rs.rows.length) return c.notFound();
  const meta = await blob.getJSON(`notes/${c.req.param("slug")}.json`);
  return c.json({ note: rs.rows[0], meta });
});

app.get("/raw/:slug", async (c) => {
  try {
    return await blob.get(`notes/${c.req.param("slug")}.json`);
  } catch {
    return c.notFound();
  }
});

app.get("/inbox", async (c) => c.json(await blob.list("inbox/")));

app.get("/secret", (c) => c.text(Deno.env.get("API_SECRET") ?? "no secret set"));

app.post("/notify", async (c) => {
  const r = await email({ to: "me@example.com", subject: "hi", text: "from the val" });
  return c.json(r);
});

export default app.fetch;
