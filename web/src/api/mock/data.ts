// mock 数据：只使用文档保留地址（RFC 5737 / RFC 3849）和 10.x 私网地址。
import type { Addr, ServerInfo } from "../types";
import { numToV4, v4ToNum } from "@/lib/ip";
import { hashStr, pick, rng } from "./rand";

export { fallbackSettings as defaultSettings } from "@/store/settings";

export type Profile = "anyip" | "nat" | "multi" | "single";

export function profileFor(host: string): Profile {
  const h = host.toLowerCase();
  if (h.includes("nat")) return "nat";
  if (h.includes("anyip") || h.includes("big")) return "anyip";
  if (h.includes("multi")) return "multi";
  if (h.includes("single")) return "single";
  if (h.startsWith("10.")) return "nat";
  if (h.startsWith("203.0.113.")) return "anyip";
  if (h.startsWith("198.51.100.")) return "nat";
  if (h.startsWith("192.0.2.")) return "single";
  return (["anyip", "nat", "multi", "single"] as Profile[])[hashStr(h) % 4];
}

function range4(start: string, count: number): string[] {
  const s = v4ToNum(start);
  return Array.from({ length: count }, (_, i) => numToV4(s + i));
}

/** 生成探测结果（出口探测前：public/probe 为空） */
export function buildInfo(host: string): ServerInfo {
  const prof = profileFor(host);
  const r = rng(host);
  const osPick = pick(r, [
    { os: "Ubuntu 22.04.4 LTS", osId: "ubuntu", osVersion: "22.04", pm: "apt", init: "systemd", kernel: "5.15.0-113-generic" },
    { os: "Debian GNU/Linux 12 (bookworm)", osId: "debian", osVersion: "12", pm: "apt", init: "systemd", kernel: "6.1.0-21-amd64" },
    { os: "Rocky Linux 9.4 (Blue Onyx)", osId: "rocky", osVersion: "9.4", pm: "dnf", init: "systemd", kernel: "5.14.0-427.el9.x86_64" },
    { os: "Alpine Linux v3.20", osId: "alpine", osVersion: "3.20.1", pm: "apk", init: "openrc", kernel: "6.6.32-0-virt" },
  ]);
  const addrs: Addr[] = [];
  const anyIP: string[] = [];
  let iface = "eth0";
  const nic = (ip: string, prefix: number, ifc = iface): Addr => ({
    ip,
    prefix,
    iface: ifc,
    family: ip.includes(":") ? 6 : 4,
    source: "nic",
    public: "",
    probe: "",
    needBind: false,
  });
  switch (prof) {
    case "anyip": {
      addrs.push(nic("203.0.113.2", 24));
      anyIP.push("203.0.113.0/24");
      for (const ip of range4("203.0.113.3", 252)) addrs.push({ ...nic(ip, 24, "lo"), source: "anyip" });
      for (let i = 2; i <= 5; i++) addrs.push(nic(`2001:db8:10::${i}`, 64));
      break;
    }
    case "nat": {
      iface = "ens5";
      addrs.push(nic("10.0.0.5", 24, iface), nic("10.0.0.6", 24, iface), nic("10.0.0.7", 24, iface));
      addrs.push(nic("2001:db8:20::10", 64, iface));
      break;
    }
    case "multi": {
      for (const ip of range4("198.51.100.10", 64)) addrs.push(nic(ip, 26));
      anyIP.push("192.0.2.0/24");
      for (const ip of range4("192.0.2.1", 254)) addrs.push({ ...nic(ip, 24, "lo"), source: "anyip" });
      for (let i = 1; i <= 8; i++) addrs.push(nic(`2001:db8:30::${i.toString(16)}`, 64));
      break;
    }
    case "single": {
      iface = "ens3";
      addrs.push(nic("192.0.2.45", 24, iface), nic("2001:db8:40::1", 64, iface));
      break;
    }
  }
  const fw = osPick.osId === "ubuntu" ? ["ufw"] : osPick.osId === "rocky" ? ["firewalld"] : osPick.osId === "debian" ? ["nftables"] : [];
  const conflicts = r() < 0.4 ? [pick(r, ["dante-server", "sing-box", "shadowsocks-libev", "squid"])] : [];
  const warnings: string[] = [];
  if (prof === "nat") warnings.push("检测到私网地址，出口需通过 NAT 映射，请在云控制台安全组放行代理端口");
  if (osPick.osId === "alpine") warnings.push("Alpine 使用 musl，将在服务器上编译 3proxy（约 30~60 秒）");
  return {
    ...osPick,
    arch: r() < 0.8 ? "x86_64" : "aarch64",
    isRoot: true,
    hasCurl: true,
    hasWget: osPick.osId !== "alpine",
    firewalls: fw,
    tcpCC: r() < 0.5 ? "bbr" : "cubic",
    memMB: pick(r, [512, 1024, 2048, 4096, 8192]),
    cpus: pick(r, [1, 2, 4, 8]),
    installed: false,
    version: "",
    conflicts,
    defaultIface: iface,
    listening: ["0.0.0.0:22", "[::]:22", "127.0.0.53:53"],
    addrs,
    anyIP,
    warnings,
    detectedAt: new Date().toISOString(),
  };
}

/** 出口探测结果：NAT 映射 + 少量失败 */
export function probeAddr(a: Addr, host: string): Addr {
  const r = rng(host + a.ip);
  if (a.ip.startsWith("10.0.0.")) {
    const last = Number(a.ip.split(".")[3]);
    return last === 7 ? { ...a, public: "", probe: "fail" } : { ...a, public: `198.51.100.${last + 2}`, probe: "ok" };
  }
  if (a.source === "manual" && !a.needBind) return { ...a, probe: "fail", public: "" };
  const fail = r() < 0.025;
  return { ...a, public: fail ? "" : a.ip, probe: fail ? "fail" : "ok" };
}

/** 展开手动添加的 IP / CIDR / 范围（最多 1024 个） */
export function expandSpec(spec: string): string[] {
  const s = spec.trim();
  if (!s) return [];
  if (s.includes("-") && !s.includes(":")) {
    const [a, b] = s.split("-").map((x) => x.trim());
    const start = v4ToNum(a);
    const end = b.includes(".") ? v4ToNum(b) : Math.floor(start / 256) * 256 + Number(b);
    if (isNaN(start) || isNaN(end) || end < start) throw new Error(`无效范围：${s}`);
    if (end - start > 1023) throw new Error(`范围过大：${s}（最多 1024 个）`);
    return Array.from({ length: end - start + 1 }, (_, i) => numToV4(start + i));
  }
  if (s.includes("/") && !s.includes(":")) {
    const [ip, p] = s.split("/");
    const pfx = Number(p);
    const base = v4ToNum(ip);
    if (isNaN(base) || !(pfx >= 22 && pfx <= 32)) throw new Error(`无效网段：${s}（支持 /22 ~ /32）`);
    const size = 2 ** (32 - pfx);
    const net = Math.floor(base / size) * size;
    if (size <= 2) return Array.from({ length: size }, (_, i) => numToV4(net + i));
    return Array.from({ length: size - 2 }, (_, i) => numToV4(net + 1 + i));
  }
  if (s.includes(":")) return [s.split("/")[0]];
  if (isNaN(v4ToNum(s))) throw new Error(`无效地址：${s}`);
  return [s];
}
