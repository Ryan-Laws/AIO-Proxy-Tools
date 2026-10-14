import * as React from "react";
import {
  ActivityIcon,
  CloudIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCwIcon,
  SquareIcon,
  Trash2Icon,
  PackageIcon,
  ServerIcon,
  PencilIcon,
} from "lucide-react";
import { api } from "@/api/client";
import type { ServerView, ServiceAction } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Callout, ConfirmDialog } from "@/components/common";
import { noteTask, run, setTab } from "@/store/store";
import { ui } from "@/store/ui";
import { fmtDateTime, fmtMem, relTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

function Stat({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="grid gap-0.5 rounded-lg border bg-muted/30 px-3 py-2">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className={cn("truncate text-sm font-semibold tabular", mono && "font-mono")}>{value}</span>
    </div>
  );
}

export function ManageTab({ s, busy }: { s: ServerView; busy: boolean }) {
  const st = s.status;
  const deployed = !!s.manifest;
  const [unOpen, setUnOpen] = React.useState(false);
  const [confirmHost, setConfirmHost] = React.useState("");

  const service = async (action: ServiceAction) => {
    const r = await run(api.service(s.id, action));
    noteTask(s.id, r?.taskId, "service");
  };
  const refresh = async () => {
    const r = await run(api.refresh(s.id));
    noteTask(s.id, r?.taskId, "refresh");
  };
  const uninstall = async () => {
    const r = await run(api.uninstall(s.id));
    noteTask(s.id, r?.taskId, "uninstall");
    if (r) setTab(s.id, "logs");
  };

  return (
    <div className="grid gap-4 p-4 md:px-6 xl:grid-cols-2">
      <Card className="xl:col-span-2">
        <CardHeader className="flex-row items-center justify-between gap-3">
          <div className="grid gap-1.5">
            <CardTitle>
              <ActivityIcon className="size-4 text-primary" />
              {t("mg.status")}
              {st ? (
                <Badge variant={st.active ? "success" : "destructive"}>
                  <span className={cn("size-1.5 rounded-full bg-current", st.active && "animate-pulse")} />
                  {st.active ? t("mg.active") : t("mg.inactive")}
                </Badge>
              ) : (
                <Badge variant="muted">{t("mg.unknown")}</Badge>
              )}
            </CardTitle>
            {!deployed && <CardDescription>{t("mg.notDeployed")}</CardDescription>}
          </div>
          <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={busy || !s.info}>
            <RefreshCwIcon />
            {t("mg.refresh")}
          </Button>
        </CardHeader>
        <CardContent className="grid gap-4">
          {st && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label={t("mg.dns")} value={<span className={st.dnsActive ? "text-success" : "text-muted-foreground"}>{st.dnsActive ? t("mg.active") : "–"}</span>} />
              <Stat label={t("mg.pid")} value={st.pid || "–"} mono />
              <Stat label={t("mg.threads")} value={st.threads || "–"} />
              <Stat label={t("mg.mem")} value={fmtMem(st.memMB)} />
              <Stat label={t("mg.conns")} value={st.connections} />
              <Stat label={t("mg.since")} value={<span title={fmtDateTime(st.since)}>{st.since ? relTime(st.since) : "–"}</span>} />
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy || !deployed || st?.active} onClick={() => void service("start")}>
              <PlayIcon className="text-success" />
              {t("mg.start")}
            </Button>
            <Button size="sm" variant="outline" disabled={busy || !deployed || st?.active === false} onClick={() => void service("stop")}>
              <SquareIcon className="text-destructive" />
              {t("mg.stop")}
            </Button>
            <Button size="sm" variant="outline" disabled={busy || !deployed} onClick={() => void service("restart")}>
              <RotateCwIcon />
              {t("mg.restart")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <PackageIcon className="size-4 text-primary" />
            {t("mg.manifest")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {deployed ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
              <dt className="text-muted-foreground">{t("mg.count")}</dt>
              <dd className="tabular">{s.manifest!.proxies?.length ?? 0}</dd>
              <dt className="text-muted-foreground">{t("mg.updatedAt")}</dt>
              <dd>{fmtDateTime(s.manifest!.updatedAt)}</dd>
              <dt className="text-muted-foreground">{t("mg.dnsEff")}</dt>
              <dd className="font-mono text-xs">{s.manifest!.dnsEffective || "–"}</dd>
              <dt className="text-muted-foreground">{t("mg.version")}</dt>
              <dd>{s.info?.version || "–"}</dd>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">{t("mg.notDeployed")}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>
            <ServerIcon className="size-4 text-primary" />
            {t("mg.server")}
          </CardTitle>
          <Button size="xs" variant="ghost" onClick={() => ui.openEdit(s)}>
            <PencilIcon />
            {t("common.edit")}
          </Button>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
            <dt className="text-muted-foreground">{t("add.host")}</dt>
            <dd className="font-mono text-xs">
              {s.host}:{s.port}
            </dd>
            <dt className="text-muted-foreground">{t("add.user")}</dt>
            <dd>{s.user}</dd>
            <dt className="text-muted-foreground">{t("add.authType")}</dt>
            <dd>
              {s.authType === "key" ? t("add.auth.key") : t("add.auth.password")}
              {s.remember && <Badge variant="success" className="ml-2">{t("vault.title")}</Badge>}
            </dd>
            {s.fingerprint && (
              <>
                <dt className="text-muted-foreground">{t("ws.fingerprint")}</dt>
                <dd className="font-mono text-[11px] break-all">{s.fingerprint}</dd>
              </>
            )}
          </dl>
        </CardContent>
      </Card>

      <Callout tone="info" icon={<CloudIcon />} className="xl:col-span-2">
        <div className="font-medium">{t("mg.sgTitle")}</div>
        <div className="text-muted-foreground">{t("mg.sgD")}</div>
      </Callout>

      <Card className="border-destructive/30 xl:col-span-2">
        <CardHeader>
          <CardTitle className="text-destructive">
            <Trash2Icon className="size-4" />
            {t("mg.danger")}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-xl text-[13px] text-muted-foreground">{t("mg.uninstallD")}</p>
          <Button
            variant="destructive"
            disabled={busy || !deployed}
            onClick={() => {
              setConfirmHost("");
              setUnOpen(true);
            }}
          >
            <Trash2Icon />
            {t("mg.uninstall")}
          </Button>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={unOpen}
        onOpenChange={setUnOpen}
        title={t("mg.uninstallTitle", { host: s.host })}
        desc={t("mg.uninstallDesc", { host: s.host })}
        destructive
        disabled={confirmHost.trim() !== s.host}
        confirmText={t("mg.uninstallBtn")}
        onConfirm={() => void uninstall()}
      >
        <Input
          autoFocus
          aria-label={t("add.host")}
          placeholder={s.host}
          value={confirmHost}
          onChange={(e) => setConfirmHost(e.target.value)}
          className="font-mono"
          spellCheck={false}
        />
      </ConfirmDialog>
    </div>
  );
}
