const greeting = Deno.env.get("GREETING") ?? "hello";

Deno.serve((req: Request) => {
  const url = new URL(req.url);
  if (url.pathname === "/health") return new Response("ok");
  return new Response(`${greeting} from ${url.pathname}`);
});

Deno.cron("tick", "*/5 * * * *", () => {
  console.log("tick");
});
