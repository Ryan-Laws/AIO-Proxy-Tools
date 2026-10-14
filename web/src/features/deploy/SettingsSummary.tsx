import type { Settings } from "@/api/types";
import { limitsSummary } from "@/lib/format";
import { t, type MessageKey } from "@/i18n";

function portDesc(r: Settings["socks"]): string {
  if (r.mode === "same") return `${t("set.port.same")} ${r.port}`;
  if (r.mode === "inc") return `${t("set.port.inc")} ${r.port}+`;
  return `${t("set.port.random")} ${r.rangeMin}-${r.rangeMax}`;
}

export function settingsRows(s: Settings): [string, string][] {
  const ports: string[] = [];
  if (s.protocol === "socks" || s.protocol === "dual") ports.push(`SOCKS5 ${portDesc(s.socks)}`);
  if (s.protocol === "http" || s.protocol === "dual") ports.push(`HTTP ${portDesc(s.http)}`);
  if (s.protocol === "auto") ports.push(portDesc(s.socks));
  const rows: [string, string][] = [
    [t("deploy.protocol"), t(`set.proto.${s.protocol}` as MessageKey)],
    [t("deploy.ports"), ports.join("；")],
    [t("deploy.auth"), t(`set.auth.${s.auth.mode}` as MessageKey) + (s.auth.mode === "custom" ? `（${s.auth.user}）` : "")],
    [t("deploy.dns"), t(`set.dns.${s.dns.mode}` as MessageKey)],
    [t("deploy.limits"), limitsSummary(s.limits) + (s.limits.expiresAt ? ` · ${t("summary.expires", { d: s.limits.expiresAt })}` : "")],
  ];
  if (s.whitelist?.length) rows.push([t("set.whitelist"), s.whitelist.join(", ")]);
  return rows;
}

export function SettingsSummary({ settings, extra }: { settings: Settings; extra?: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg border bg-muted/30 px-4 py-3 text-[13px]">
      {extra?.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="font-medium">{v}</dd>
        </div>
      ))}
      {settingsRows(settings).map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="break-all">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
