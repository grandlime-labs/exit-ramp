import { helper } from "https://esm.town/v/someone/helper";
import { OpenAI } from "https://esm.town/v/std/openai";
import { serveFile } from "https://esm.town/v/std/utils@85-main/index.ts";
import { parse } from "https://deno.land/x/somelib@v1.2.3/mod.ts";
import { sleep } from "https://deno.land/std@0.224.0/async/delay.ts";

const text = await Deno.readTextFile("./data.txt");
Deno.env.set("X", "1");

export default async function (req: Request): Promise<Response> {
  if (new URL(req.url).pathname === "/quit") Deno.exit(0);
  await sleep(1);
  return new Response(helper(parse(text)) + String(OpenAI) + String(serveFile));
}
