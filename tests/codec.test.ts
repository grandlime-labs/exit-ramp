import { describe, expect, it } from "vitest";
import { compareEncoded, decodeKey, deserialize, encodeKey, prefixFor, serialize, toBulk, type KvKeyPart } from "../templates/kv-codec";

// Deno KV's documented part order: Uint8Array < string < bigint < number < boolean
const rank = (p: KvKeyPart) => (p instanceof Uint8Array ? 0 : typeof p === "string" ? 1 : typeof p === "bigint" ? 2 : typeof p === "number" ? 3 : 4);
function cmpPart(a: KvKeyPart, b: KvKeyPart): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return Math.sign(a.length - b.length);
  }
  if (typeof a === "string" && typeof b === "string") {
    const ea = new TextEncoder().encode(a);
    const eb = new TextEncoder().encode(b);
    return cmpPart(ea, eb);
  }
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return a < b ? -1 : a > b ? 1 : 0;
}
function cmpTuple(a: readonly KvKeyPart[], b: readonly KvKeyPart[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = cmpPart(a[i], b[i]);
    if (c) return c;
  }
  return Math.sign(a.length - b.length);
}

// small deterministic PRNG so failures are reproducible
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}
const CHARS = ["a", "b", "z", "A", "!", '"', " ", "\u0000", "\u0001", "é", "中", "\u{1F600}", "\uE000", "\uFFFF", "0", "~"];
function randPart(r: () => number): KvKeyPart {
  const k = Math.floor(r() * 5);
  if (k === 0) return Uint8Array.from({ length: Math.floor(r() * 4) }, () => Math.floor(r() * 256));
  if (k === 1) return Array.from({ length: Math.floor(r() * 5) }, () => CHARS[Math.floor(r() * CHARS.length)]).join("");
  if (k === 2) return BigInt(Math.floor((r() - 0.5) * 1e6)) * BigInt(Math.floor(r() * 1e6) + 1) * (r() < 0.2 ? 10n ** 30n : 1n);
  if (k === 3) return [0, 1, -1, 0.5, -0.5, 1e300, -1e300, 5e-324, 12, 5, 100, Math.floor((r() - 0.5) * 1e9) / 7][Math.floor(r() * 12)];
  return r() < 0.5;
}
const randKey = (r: () => number) => Array.from({ length: 1 + Math.floor(r() * 3) }, () => randPart(r));

describe("kv-codec", () => {
  it("round-trips every part type", () => {
    const r = rng(1);
    for (let i = 0; i < 500; i++) {
      const k = randKey(r);
      const back = decodeKey(encodeKey(k));
      expect(back.length).toBe(k.length);
      back.forEach((p, j) => {
        const q = k[j];
        if (q instanceof Uint8Array) expect(Array.from(p as Uint8Array)).toEqual(Array.from(q));
        else expect(p).toStrictEqual(q);
      });
    }
  });

  it("encoded order equals Deno tuple order (property test, 4000 random pairs)", () => {
    const r = rng(42);
    for (let i = 0; i < 4000; i++) {
      const a = randKey(r);
      const b = randKey(r);
      const want = Math.sign(cmpTuple(a, b));
      const got = Math.sign(compareEncoded(encodeKey(a), encodeKey(b)));
      if (want !== got) throw new Error(`order mismatch for ${JSON.stringify(a, (_, v) => (typeof v === "bigint" ? v + "n" : v))} vs ${JSON.stringify(b, (_, v) => (typeof v === "bigint" ? v + "n" : v))}: want ${want} got ${got}`);
    }
  });

  it("numbers sort numerically, not lexically (the classic id bug)", () => {
    const keys = [["users", 12], ["users", 5], ["users", 100], ["users", -3]] as KvKeyPart[][];
    const sorted = keys.map(encodeKey).sort(compareEncoded).map((k) => decodeKey(k)[1]);
    expect(sorted).toEqual([-3, 5, 12, 100]);
  });

  it("prefix queries match children but not siblings with a longer first part", () => {
    const p = prefixFor(["a"]);
    expect(encodeKey(["a", 1]).startsWith(p)).toBe(true);
    expect(encodeKey(["ab", 1]).startsWith(p)).toBe(false);
    expect(prefixFor([])).toBe("");
  });

  it("rejects keys over 512 bytes and empty keys", () => {
    expect(() => encodeKey(["x".repeat(600)])).toThrow(/512/);
    expect(() => encodeKey([])).toThrow();
  });

  it("serializes Date, Map, Set, bigint, bytes, undefined, NaN and nested objects", () => {
    const v = { d: new Date(0), m: new Map([["a", 1]]), s: new Set([1, 2]), b: 10n ** 20n, u8: new Uint8Array([1, 2]), un: undefined, nan: NaN, inf: -Infinity, nested: { x: [1, { y: new Date(5) }] } };
    const back = deserialize<typeof v>(serialize(v));
    expect(back.d).toEqual(new Date(0));
    expect(back.m).toEqual(new Map([["a", 1]]));
    expect(back.s).toEqual(new Set([1, 2]));
    expect(back.b).toBe(10n ** 20n);
    expect(Array.from(back.u8)).toEqual([1, 2]);
    expect("un" in back && back.un === undefined).toBe(true);
    expect(back.nan).toBeNaN();
    expect(back.inf).toBe(-Infinity);
    expect(back.nested.x[1]).toEqual({ y: new Date(5) });
  });

  it("toBulk produces wrangler kv bulk put items", () => {
    const items = toBulk([{ key: ["a", 1], value: { n: 1 } }]);
    expect(items).toEqual([{ key: encodeKey(["a", 1]), value: serialize({ n: 1 }) }]);
  });
});
