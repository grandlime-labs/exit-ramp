import { z } from "npm:zod@3";

const Title = z.string().min(1);

export function slugify(title: string): string {
  return Title.parse(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
