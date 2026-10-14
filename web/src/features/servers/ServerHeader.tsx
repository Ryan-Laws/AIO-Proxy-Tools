import * as React from "react";
import {
  AlertTriangleIcon,
  BoxIcon,
  CpuIcon,
  FingerprintIcon,
  MonitorIcon,
  PencilIcon,
  RadarIcon,
  ShieldIcon,
  ShieldAlertIcon,
  TerminalSquareIcon,
  XCircleIcon,
} from "lucide-react";
import type { ServerView, TaskView } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tip } from "@/components/ui/tooltip";
import { Callout, ConfirmDialog, StateBadge } from "@/components/common";
import { detect, setTab } from "@/store/store";
import { ui } from "@/store/ui";
import { fmtMem, relTime } from "@/lib/format";
import { t } from "@/i18n";

function Chip({ icon, label, value, title }: { icon: React.ReactNode; label: string; value: React.ReactNode; title?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs" title={title}>
      <span className="text-muted-foreground [&_svg]:size-3.5">{icon}</span>
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate font-medium">{value}</span>
    </div>
  );
}

export function isHostKeyError(err: string): boolean {
  return /host key|主机密钥|指纹|fingerprint/i.test(err);
}

export function ServerHeader({ s, task }: { s: ServerView; task?: TaskView }) {
  const [trustOpen, setTrustOpen] = React.useState(false);
  const running = task?.state === "running";
  const i = s.info;
  const keyErr = s.state === "error" && isHostKeyError(s.error);

  return (
    <div className="grid gap-3 border-b bg-card/60 px-4 py-3 md:px-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold tracking-tight">{s.name || s.host}</h2>
            <StateBadge state={s.state} busy={running} />
          </div>
          <div className="flex flex-wrap items-center gap-x-2 font-mono text-xs text-muted-foreground">
            <span>
              {s.user}@{s.host}:{s.port}
            </span>
            {i?.detectedAt && <span className="font-sans">· {t("ws.detectedAt", { t: relTime(i.detectedAt) })}</span>}
            {s.fingerprint && (
              <Tip content={`${t("ws.fingerprint")}：${s.fingerprint}`}>
                <FingerprintIcon className="size-3.5" tabIndex={0} aria-label={t("ws.fingerprint")} />
              </Tip>
            )}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {keyErr && (
            <Button size="sm" variant="destructive" onClick={() => setTrustOpen(true)} disabled={running}>
              <ShieldAlertIcon />
              {t("ws.trustKey")}
            </Button>
          )}
          <Tip content={t("ws.editServer")}>
            <Button size="icon-sm" variant="outline" onClick={() => ui.openEdit(s)} aria-label={t("ws.editServer")}>
              <PencilIcon />
            </Button>
          </Tip>
          <Button
            size="sm"
            variant={s.info ? "outline" : "default"}
            disabled={running}
            onClick={() => {
              void detect(s.id);
              setTab(s.id, "logs");
            }}
          >
            <RadarIcon className={running && task?.kind === "detect" ? "animate-pulse" : ""} />
            {s.info ? t("ws.redetect") : t("ws.startDetect")}
          </Button>
        </div>
      </div>

      {i && (
        <div className="flex flex-wrap gap-1.5">
          <Chip icon={<MonitorIcon />} label={t("ws.os")} value={i.os || i.osId} title={i.kernel} />
          <Chip icon={<CpuIcon />} label={t("ws.hw")} value={`${i.arch} · ${t("ws.cores", { n: i.cpus })} · ${fmtMem(i.memMB)}`} />
          <Chip icon={<TerminalSquareIcon />} label={t("ws.init")} value={`${i.init}${i.pm ? ` · ${i.pm}` : ""}`} />
          <Chip icon={<ShieldIcon />} label={t("ws.firewall")} value={i.firewalls?.length ? i.firewalls.join(", ") : t("ws.fwNone")} />
          <Chip
            icon={<BoxIcon />}
            label={t("ws.installed")}
            value={i.installed ? <span className="text-success">{i.version || "✓"}</span> : <span className="text-muted-foreground">{t("ws.notInstalled")}</span>}
          />
          {!i.isRoot && (
            <Badge variant="warning" className="h-[26px]">
              {t("ws.nonRoot")}
            </Badge>
          )}
        </div>
      )}

      {s.state === "error" && s.error && !running && (
        <Callout tone="danger" icon={<XCircleIcon />}>
          {s.error}
        </Callout>
      )}
      {i?.conflicts && i.conflicts.length > 0 && (
        <Callout tone="warning" icon={<AlertTriangleIcon />}>
          {t("ws.conflicts", { list: i.conflicts.join("、") })}
        </Callout>
      )}
      {i?.warnings && i.warnings.length > 0 && (
        <Callout tone="info" icon={<AlertTriangleIcon />}>
          <ul className="grid gap-0.5">
            {i.warnings.map((w, k) => (
              <li key={k}>{w}</li>
            ))}
          </ul>
        </Callout>
      )}

      <ConfirmDialog
        open={trustOpen}
        onOpenChange={setTrustOpen}
        title={t("ws.trustKeyTitle")}
        desc={t("ws.trustKeyDesc")}
        destructive
        confirmText={t("ws.trustKey")}
        onConfirm={() => {
          void detect(s.id, true);
          setTab(s.id, "logs");
        }}
      />
    </div>
  );
}
