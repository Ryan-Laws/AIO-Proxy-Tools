import { t } from "@/i18n";
import type { Limits } from "@/api/types";

export function fmtMB(mb: number): string {
  if (!mb || mb <= 0) return "0";
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  const gb = mb / 1024;
  if (gb < 1024) return `${Number(gb < 10 ? gb.toFixed(2) : gb.toFixed(1))} GB`;
  return `${(gb / 1024).toFixed(2)} TB`;
}

export function fmtMem(mb: number): string {
  if (!mb) return "–";
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`;
}

export function fmtTime(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime()) || d.getFullYear() < 2000) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtDateTime(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime()) || d.getFullYear() < 2000) return iso ?? "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function relTime(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso).getTime();
  if (isNaN(d)) return "";
  const s = Math.round((Date.now() - d) / 1000);
  if (s < 0) return fmtDateTime(iso);
  if (s < 60) return t("time.now");
  if (s < 3600) return t("time.min", { n: Math.floor(s / 60) });
  if (s < 86400) return t("time.hour", { n: Math.floor(s / 3600) });
  return t("time.day", { n: Math.floor(s / 86400) });
}

const periodLabel = (p: string) => t(p === "D" ? "period.D" : p === "W" ? "period.W" : "period.M");

export function limitsSummary(l: Limits | null | undefined): string {
  if (!l) return t("common.unlimited");
  const parts: string[] = [];
  if (l.speedMbps > 0) parts.push(`${l.speedMbps} Mbps`);
  if (l.maxConn > 0) parts.push(t("lim.conn", { n: l.maxConn }));
  if (l.quotaGB > 0) parts.push(`${l.quotaGB} GB/${periodLabel(l.quotaPeriod)}`);
  return parts.length ? parts.join(" · ") : t("common.unlimited");
}

export function isExpired(date: string): boolean {
  if (!date) return false;
  const d = new Date(date + "T23:59:59");
  return !isNaN(d.getTime()) && d.getTime() < Date.now();
}

export function plural(n: number): string {
  return n.toLocaleString("zh-CN");
}
