// 可复现的伪随机（mock 专用）

export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function rng(seed: number | string) {
  let a = typeof seed === "string" ? hashStr(seed) : seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALNUM = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LOWER = "abcdefghijkmnpqrstuvwxyz23456789";

export function randStr(r: () => number, len: number, lower = false): string {
  const cs = lower ? LOWER : ALNUM;
  let s = "";
  for (let i = 0; i < len; i++) s += cs[Math.floor(r() * cs.length)];
  return s;
}

export function pick<T>(r: () => number, arr: T[]): T {
  return arr[Math.floor(r() * arr.length)];
}

export function uid(prefix = ""): string {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
