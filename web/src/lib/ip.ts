// IP 工具：比较、网段分组、IPv6 方括号。

export function isV6(ip: string): boolean {
  return ip.includes(":");
}

/** URL 形式里 IPv6 需加方括号 */
export function hostForUrl(ip: string): string {
  return isV6(ip) && !ip.startsWith("[") ? `[${ip}]` : ip;
}

export function v4ToNum(ip: string): number {
  const p = ip.split(".");
  if (p.length !== 4) return NaN;
  let n = 0;
  for (const s of p) {
    const v = Number(s);
    if (!/^\d{1,3}$/.test(s) || v > 255) return NaN;
    n = n * 256 + v;
  }
  return n;
}

export function numToV4(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** 展开 IPv6 为 8 组 16 位数字，失败返回 null */
export function v6Groups(ip: string): number[] | null {
  const s = ip.replace(/^\[|\]$/g, "").split("%")[0];
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (h: string) => (h ? h.split(":").map((x) => parseInt(x, 16)) : []);
  const a = parse(halves[0]);
  const b = halves.length === 2 ? parse(halves[1]) : [];
  if ([...a, ...b].some((x) => isNaN(x) || x < 0 || x > 0xffff)) return null;
  const fill = 8 - a.length - b.length;
  if (halves.length === 1 && fill !== 0) return null;
  if (fill < 0) return null;
  return [...a, ...new Array(fill).fill(0), ...b];
}

export function compareIP(a: string, b: string): number {
  const a6 = isV6(a);
  const b6 = isV6(b);
  if (a6 !== b6) return a6 ? 1 : -1;
  if (!a6) return v4ToNum(a) - v4ToNum(b);
  const ga = v6Groups(a) ?? [];
  const gb = v6Groups(b) ?? [];
  for (let i = 0; i < 8; i++) {
    const d = (ga[i] ?? 0) - (gb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** 分组键：IPv4 取 /24，IPv6 取 /64 */
export function subnetKey(ip: string): string {
  if (!isV6(ip)) {
    const p = ip.split(".");
    return `${p[0]}.${p[1]}.${p[2]}.0/24`;
  }
  const g = v6Groups(ip);
  if (!g) return ip;
  return `${g
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(":")}::/64`;
}

export const isValidV4 = (s: string) => !isNaN(v4ToNum(s));
export const isValidV6 = (s: string) => isV6(s) && v6Groups(s) !== null;
export const isValidIP = (s: string) => isValidV4(s) || isValidV6(s);

/** 校验白名单项：IP 或 CIDR */
export function isValidCidrOrIP(s: string): boolean {
  const [ip, pfx] = s.split("/");
  if (!isValidIP(ip)) return false;
  if (pfx === undefined) return true;
  if (!/^\d{1,3}$/.test(pfx)) return false;
  const n = Number(pfx);
  return isV6(ip) ? n <= 128 : n <= 32;
}

/** 校验手动添加项：IP、CIDR 或 a-b 范围 */
export function isValidAddrSpec(s: string): boolean {
  if (s.includes("-")) {
    const [a, b] = s.split("-").map((x) => x.trim());
    if (isValidV4(a) && isValidV4(b)) return v4ToNum(a) <= v4ToNum(b);
    if (isValidV4(a) && /^\d{1,3}$/.test(b)) return Number(b) <= 255 && Number(b) >= Number(a.split(".")[3]);
    return isValidV6(a) && isValidV6(b);
  }
  return isValidCidrOrIP(s);
}

export function splitList(text: string): string[] {
  return text
    .split(/[\s,;，；]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}
