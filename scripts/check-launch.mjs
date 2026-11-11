// Checks the X post drafts in LAUNCH.md: each must be <= 280 chars with the URL placeholder counted as 23 (t.co length).
import { readFileSync } from "node:fs";
const md = readFileSync(new URL("../LAUNCH.md", import.meta.url), "utf8");
const section = md.split("## 5. Three X posts")[1].split("## 6.")[0];
const posts = [...section.matchAll(/```\n([\s\S]*?)\n```/g)].map((m) => m[1]);
let bad = 0;
posts.forEach((p, i) => {
  const n = [...p.replace(/\{\{URL\}\}/g, "x".repeat(23))].length;
  console.log(`post ${i + 1}: ${n} chars ${n <= 280 ? "ok" : "TOO LONG"}`);
  if (n > 280) bad++;
});
if (posts.length !== 3) {
  console.log(`expected 3 posts, found ${posts.length}`);
  bad++;
}
// no invented statistics: flag digits followed by users/stars/downloads/hours/%
const stats = md.match(/\b\d[\d,.]*\s*(?:%|users|stars|downloads|hours saved|customers)\b/gi);
if (stats) {
  console.log("possible invented stat:", stats);
  bad++;
}
process.exit(bad ? 1 : 0);
