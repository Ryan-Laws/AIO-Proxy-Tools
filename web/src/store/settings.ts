import type { Settings } from "@/api/types";

/** 后端未返回默认值时使用（与后端默认保持一致） */
export function fallbackSettings(): Settings {
  return {
    protocol: "dual",
    socks: { mode: "same", port: 1080, rangeMin: 20000, rangeMax: 40000 },
    http: { mode: "same", port: 8080, rangeMin: 40001, rangeMax: 60000 },
    auth: { mode: "per", user: "", pass: "", userPrefix: "u", userLen: 8, passLen: 16, list: [] },
    whitelist: [],
    limits: { speedMbps: 0, maxConn: 0, quotaGB: 0, quotaPeriod: "M", expiresAt: "" },
    dns: { mode: "recursive", servers: ["1.1.1.1", "9.9.9.9"] },
    keepExisting: true,
    firewall: true,
    bbr: true,
    tune: true,
    blockPrivate: true,
    udp: false,
    log: false,
    maxConn: 4096,
    stopConflicts: [],
    githubMirror: "",
  };
}

/** 补齐 null / 缺失字段，保证表单可直接绑定 */
export function normalizeSettings(s: Partial<Settings> | null | undefined): Settings {
  const d = fallbackSettings();
  if (!s) return d;
  return {
    ...d,
    ...s,
    socks: { ...d.socks, ...(s.socks ?? {}) },
    http: { ...d.http, ...(s.http ?? {}) },
    auth: { ...d.auth, ...(s.auth ?? {}), list: s.auth?.list ?? [] },
    whitelist: s.whitelist ?? [],
    limits: { ...d.limits, ...(s.limits ?? {}) },
    dns: { ...d.dns, ...(s.dns ?? {}), servers: s.dns?.servers ?? d.dns.servers },
    stopConflicts: s.stopConflicts ?? [],
    githubMirror: s.githubMirror ?? "",
  };
}

// 与后端 internal/threeproxy.ECSResolvers 保持一致
export const ECS_DNS = ["8.8.8.8", "8.8.4.4", "9.9.9.11", "149.112.112.11", "2001:4860:4860::8888", "2001:4860:4860::8844"];
export const NAME_RE = /^[A-Za-z0-9._-]+$/;
