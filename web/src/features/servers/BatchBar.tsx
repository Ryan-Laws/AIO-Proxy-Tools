import * as React from "react";
import { FlaskConicalIcon, RadarIcon, RefreshCwIcon, RocketIcon, Trash2Icon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/api/client";
import type { BatchAction } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Callout, ConfirmDialog } from "@/components/common";
import { draftOf, defaultsOf, noteTask, removeServer, run, setChecked, useApp } from "@/store/store";
import { SettingsSummary } from "@/features/deploy/SettingsSummary";
import { t } from "@/i18n";

export function BatchBar() {
  const checked = useApp((s) => s.checked);
  const servers = useApp((s) => s.servers);
  const selectedId = useApp((s) => s.selectedId);
  const [deployOpen, setDeployOpen] = React.useState(false);
  const [removeOpen, setRemoveOpen] = React.useState(false);
  if (!checked.length) return null;

  const fromServer = selectedId && servers[selectedId] ? servers[selectedId] : null;
  const settings = fromServer ? draftOf(fromServer.id) : defaultsOf();
  const undetected = checked.filter((id) => !servers[id]?.info).length;

  const go = async (action: BatchAction) => {
    const r = await run(api.batch(action, checked, action === "deploy" ? settings : undefined));
    if (!r) return;
    const entries = Object.entries(r.taskIds ?? {});
    for (const [sid, tid] of entries) noteTask(sid, tid, action);
    toast.success(t("batch.started", { n: entries.length }));
  };

  const btn = (icon: React.ReactNode, label: string, onClick: () => void, variant: "outline" | "default" = "outline") => (
    <Button size="sm" variant={variant} onClick={onClick} className="h-12 flex-col gap-1 px-0 text-[11px] has-[>svg]:px-0">
      {icon}
      {label}
    </Button>
  );

  return (
    <div className="anim-pop-in mx-2 mb-2 rounded-xl border bg-card p-2.5 shadow-md">
      <div className="mb-2 flex items-center justify-between px-0.5 text-xs font-medium">
        <span>{t("batch.selected", { n: checked.length })}</span>
        <Button variant="ghost" size="icon-xs" className="size-6" onClick={() => setChecked([])} aria-label={t("batch.clear")}>
          <XIcon />
        </Button>
      </div>
      <div className="grid grid-cols-5 gap-1.5">
        {btn(<RadarIcon />, t("batch.detect"), () => void go("detect"))}
        {btn(<RocketIcon />, t("batch.deploy"), () => setDeployOpen(true), "default")}
        {btn(<FlaskConicalIcon />, t("batch.test"), () => void go("test"))}
        {btn(<RefreshCwIcon />, t("batch.refresh"), () => void go("refresh"))}
        {btn(<Trash2Icon className="text-destructive" />, t("batch.remove"), () => setRemoveOpen(true))}
      </div>

      <ConfirmDialog
        open={deployOpen}
        onOpenChange={setDeployOpen}
        title={t("batch.deployTitle", { n: checked.length })}
        desc={t("batch.deployDesc")}
        confirmText={t("deploy.start")}
        onConfirm={() => void go("deploy")}
      >
        <div className="grid gap-3">
          <p className="text-xs text-muted-foreground">
            {fromServer ? t("batch.settingsFrom", { name: fromServer.name || fromServer.host }) : t("batch.settingsDefault")}
          </p>
          <SettingsSummary settings={settings} />
          {undetected > 0 && <Callout tone="warning">{t("batch.notDetected", { n: undetected })}</Callout>}
          <Callout tone="muted">{t("deploy.sgHint")}</Callout>
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={t("batch.removeTitle", { n: checked.length })}
        desc={t("batch.removeDesc")}
        destructive
        confirmText={t("common.remove")}
        onConfirm={() => {
          for (const id of checked) void removeServer(id);
        }}
      />
    </div>
  );
}
