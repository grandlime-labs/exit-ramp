import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { convert, scan, type ConvertOptions, type InputFile } from "../src/core/index";

export const ROOT = join(import.meta.dirname, "..");

export function fixture(name: string): InputFile[] {
  const base = join(ROOT, "fixtures", name);
  const out: InputFile[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push({ path: relative(base, p).split("\\").join("/"), text: readFileSync(p, "utf8") });
    }
  };
  walk(base);
  return out;
}

export const files = (o: Record<string, string>): InputFile[] => Object.entries(o).map(([path, text]) => ({ path, text }));

export function convertOne(path: string, text: string, opts: ConvertOptions = {}) {
  const r = convert([{ path, text }], opts);
  const get = (p: string) => r.output.find((f) => f.path === p)?.content;
  return { r, out: get("src/" + path) ?? "", get, rules: r.findings.map((f) => f.rule) };
}

export { convert, scan };
