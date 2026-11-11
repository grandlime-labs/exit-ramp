// Compare-and-set with versionstamps: cannot be done on Workers KV.
export async function acquire(kv: Deno.Kv, name: string): Promise<boolean> {
  const key = ["locks", name];
  const cur = await kv.get(key);
  const res = await kv.atomic().check({ key, versionstamp: cur.versionstamp }).set(key, Date.now()).commit();
  return res.ok;
}
