import type { Proxy, ServerView, TestResult } from "@/api/types";
import { hostForUrl } from "./ip";

export type ExportFormat = "colon" | "at" | "url" | "csv" | "template";
export type ProtoFilter = "all" | "socks" | "http";

export interface ExportOptions {
  format: ExportFormat;
  proto: ProtoFilter;
  onlyPassed: boolean;
  template: string;
}

export interface ExportRow {
  server: string;
  proxy: Proxy;
  local?: TestResult;
  remote?: TestResult;
  /** true 通过 / false 失败 / null 未测试 */
  passed: boolean | null;
  egress: string;
}

export const DEFAULT_TEMPLATE = "{proto}://{user}:{pass}@{host}:{port}";

export function testsByProxy(tests: TestResult[] | null | undefined) {
  const m = new Map<string, { local?: TestResult; remote?: TestResult }>();
  for (const t of tests ?? []) {
    const e = m.get(t.proxyId) ?? {};
    if (t.where === "server") e.remote = t;
    else e.local = t;
    m.set(t.proxyId, e);
  }
  return m;
}

export function buildRows(srv: ServerView): ExportRow[] {
  const tm = testsByProxy(srv.tests);
  return (srv.manifest?.proxies ?? []).map((p) => {
    const t = tm.get(p.id) ?? {};
    const passed = t.local ? t.local.ok : t.remote ? t.remote.ok : null;
    return {
      server: srv.name || srv.host,
      proxy: p,
      local: t.local,
      remote: t.remote,
      passed,
      egress: t.local?.egress || t.remote?.egress || p.public,
    };
  });
}

function matchProto(p: Proxy, f: ProtoFilter): boolean {
  if (f === "all") return true;
  return p.protocol === f || p.protocol === "auto";
}

export function schemeOf(p: Proxy, f: ProtoFilter): string {
  if (p.protocol === "http") return "http";
  if (p.protocol === "socks") return "socks5";
  return f === "http" ? "http" : "socks5";
}

export function filterRows(rows: ExportRow[], o: Pick<ExportOptions, "proto" | "onlyPassed">): ExportRow[] {
  return rows.filter((r) => matchProto(r.proxy, o.proto) && (!o.onlyPassed || r.passed === true));
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function testText(r: ExportRow): string {
  const parts: string[] = [];
  if (r.local) parts.push(`local:${r.local.ok ? `ok ${r.local.latencyMs}ms` : `fail ${r.local.error ?? ""}`.trim()}`);
  if (r.remote) parts.push(`server:${r.remote.ok ? "ok" : "fail"}`);
  return parts.join(" ") || "untested";
}

export const CSV_HEADER = ["server", "protocol", "ip", "port", "user", "pass", "listen", "egress", "test"];

export function renderLine(r: ExportRow, o: ExportOptions): string {
  const p = r.proxy;
  const host = hostForUrl(p.public || p.listen);
  const auth = p.user ? `${p.user}:${p.pass}` : "";
  const scheme = schemeOf(p, o.proto);
  switch (o.format) {
    case "colon":
      return auth ? `${host}:${p.port}:${auth}` : `${host}:${p.port}`;
    case "at":
      return auth ? `${auth}@${host}:${p.port}` : `${host}:${p.port}`;
    case "url":
      return `${scheme}://${auth ? auth + "@" : ""}${host}:${p.port}`;
    case "csv":
      return [r.server, scheme, p.public || p.listen, p.port, p.user, p.pass, p.listen, r.egress, testText(r)].map(csvCell).join(",");
    case "template":
      return (o.template || DEFAULT_TEMPLATE)
        // 无认证代理：去掉整段 "{user}:{pass}@"，避免导出 socks5://:@host:port
        .replace(/\{user\}:\{pass\}@/g, auth ? `${auth}@` : "")
        .replace(/\{ip\}/g, p.public || p.listen)
        .replace(/\{host\}/g, host)
        .replace(/\{port\}/g, String(p.port))
        .replace(/\{user\}/g, p.user)
        .replace(/\{pass\}/g, p.pass)
        .replace(/\{proto\}/g, scheme)
        .replace(/\{egress\}/g, r.egress)
        .replace(/\{listen\}/g, p.listen)
        .replace(/\{server\}/g, r.server);
  }
}

export function renderExport(rows: ExportRow[], o: ExportOptions, header = true): string {
  const lines = filterRows(rows, o).map((r) => renderLine(r, o));
  if (o.format === "csv" && header) lines.unshift(CSV_HEADER.join(","));
  return lines.join("\n");
}

export function fileSafe(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "server";
}
