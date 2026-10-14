import * as React from "react";
import {
  AlertTriangleIcon,
  ClipboardCheckIcon,
  CopyCheckIcon,
  Loader2Icon,
  RocketIcon,
  RotateCcwIcon,
  SaveIcon,
  TableIcon,
  XCircleIcon,
  PencilLineIcon,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/api/client";
import type { PlanResult, ServerView, Settings } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Callout, ConfirmDialog } from "@/components/common";
import {
  defaultsOf,
  draftOf,
  errMsg,
  flushSelection,
  noteTask,
  run,
  savePrefs,
  setDraft,
  setEdits,
  setTab,
  useApp,
} from "@/store/store";
import { useDebounced } from "@/lib/dom";
import { SettingsSummary } from "@/features/deploy/SettingsSummary";
import { PlanDialog } from "@/features/deploy/PlanDialog";
import { SettingsForm, validateSettings } from "./SettingsForm";
import { t } from "@/i18n";

const EMPTY: string[] = [];

function textsOf(s: Settings) {
  return {
    whitelist: (s.whitelist ?? []).join("\n"),
    list: (s.auth.list ?? []).map((c) => `${c.user}:${c.pass}`).join("\n"),
    dns: (s.dns.servers ?? []).join(", "),
  };
}

export function SettingsTab({ s, busy }: { s: ServerView; busy: boolean }) {
  const stored = useApp((st) => st.drafts[s.id]);
  const prefs = useApp((st) => st.prefs);
  const checked = useApp((st) => st.checked);
  const selection = useApp((st) => st.selection[s.id] ?? st.servers[s.id]?.selected ?? EMPTY);
  const editsEntry = useApp((st) => st.edits[s.id]);
  const draft = React.useMemo(() => stored ?? draftOf(s.id), [stored, s.id, prefs, s.manifest?.settings]);
  const [texts, setTextsState] = React.useState(() => textsOf(draft));
  const setTexts = (p: Partial<typeof texts>) => setTextsState((x) => ({ ...x, ...p }));
  const update = (n: Settings) => setDraft(s.id, n);

  const errors = validateSettings(draft, texts);
  const hasErrors = Object.values(errors).some(Boolean);

  // ---- 计划（防抖调用 /plan） ----
  const planKey = JSON.stringify({ d: draft, sel: selection });
  const debKey = useDebounced(planKey, 450);
  const [plan, setPlan] = React.useState<PlanResult | null>(null);
  const [planErr, setPlanErr] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const edits = editsEntry && editsEntry.key === planKey ? editsEntry.proxies : null;

  React.useEffect(() => {
    if (editsEntry && editsEntry.key !== planKey) setEdits(s.id, null);
  }, [editsEntry, planKey, s.id]);

  // 预览表里手改过的清单也交给后端校验（端口占用、账号规则等以后端为准）
  const editsJSON = edits ? JSON.stringify(edits) : "";
  React.useEffect(() => {
    if (!s.info) return;
    if (!selection.length) {
      setPlan(null);
      setPlanErr("");
      return;
    }
    if (hasErrors) {
      setPlan(null);
      return;
    }
    let stale = false;
    setLoading(true);
    api
      .plan(s.id, { settings: draft, selected: selection, edited: edits })
      .then((r) => {
        if (stale) return;
        setPlan(r);
        setPlanErr("");
      })
      .catch((e) => !stale && setPlanErr(errMsg(e)))
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
    };
    // 只在防抖后的 key、手改内容或探测结果（重新探测后端口占用、公网地址可能变化）变化时请求
    }, [debKey, editsJSON, s.id, s.info?.detectedAt]);

  const proxies = edits ?? plan?.proxies ?? [];
  const planErrors = [...(plan?.errors ?? []), ...(planErr ? [planErr] : [])];
  const stalePlan = debKey !== planKey || loading;
  const canDeploy = !busy && !hasErrors && selection.length > 0 && !!plan && !planErrors.length && !stalePlan && proxies.length > 0;

  const [planOpen, setPlanOpen] = React.useState(false);
  const [deployOpen, setDeployOpen] = React.useState(false);
  const [ack, setAck] = React.useState(false);
  const dangerNoAuth = draft.auth.mode === "none" && !(draft.whitelist ?? []).length;

  const deploy = async () => {
    await flushSelection(s.id);
    const r = await run(api.deploy(s.id, { settings: draft, selected: selection, edited: edits }));
    if (!r) return;
    noteTask(s.id, r.taskId, "deploy");
    setEdits(s.id, null);
    setTab(s.id, "logs");
  };

  const ipsCount = selection.length;

  return (
    <div className="grid gap-4 p-4 md:px-6 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_360px]">
      {/* 摘要 */}
      <div className="lg:order-last">
        <div className="grid gap-3 lg:sticky lg:top-4">
          <Card className="overflow-hidden">
            <CardHeader className="border-b bg-gradient-to-br from-primary/[0.07] to-transparent">
              <CardTitle className="text-sm text-muted-foreground">{t("set.summary")}</CardTitle>
              {selection.length === 0 ? (
                <div className="pt-1 text-lg font-semibold">{t("set.summaryNoSel")}</div>
              ) : (
                <div className="flex items-baseline gap-2 pt-1">
                  <span className="text-3xl font-bold tracking-tight tabular">{plan || edits ? proxies.length : "–"}</span>
                  <span className="text-sm text-muted-foreground">{t("set.proxiesUnit")} · {t("set.summaryIPs", { n: ipsCount })}</span>
                  {(loading || stalePlan) && <Loader2Icon className="ml-auto size-4 animate-spin text-muted-foreground" />}
                </div>
              )}
            </CardHeader>
            <CardContent className="grid gap-3 pt-4">
              {plan?.ports && plan.ports.length > 0 && (
                <div className="grid gap-1">
                  <div className="text-xs text-muted-foreground">{t("set.summaryPorts")}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {plan.ports.map((p) => (
                      <span key={p} className="rounded-md border bg-muted/50 px-2 py-0.5 font-mono text-xs">
                        {p}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {edits && (
                <Callout tone="info" icon={<PencilLineIcon />}>
                  {t("set.edited", { n: edits.length })}
                  <button className="ml-1 cursor-pointer text-primary underline-offset-2 hover:underline" onClick={() => setEdits(s.id, null)}>
                    {t("set.discardEdits")}
                  </button>
                </Callout>
              )}
              {planErrors.length > 0 && (
                <Callout tone="danger" icon={<XCircleIcon />}>
                  <ul className="grid gap-0.5">
                    {planErrors.slice(0, 6).map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                    {planErrors.length > 6 && <li>…</li>}
                  </ul>
                </Callout>
              )}
              {hasErrors && <Callout tone="danger" icon={<XCircleIcon />}>{t("set.fixErrors")}</Callout>}
              {plan?.warnings && plan.warnings.length > 0 && (
                <Callout tone="warning" icon={<AlertTriangleIcon />}>
                  <ul className="grid gap-0.5">
                    {plan.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </Callout>
              )}
              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" disabled={!proxies.length || stalePlan} onClick={() => setPlanOpen(true)}>
                  <TableIcon />
                  {t("set.preview")}
                </Button>
                <Button
                  disabled={!canDeploy}
                  onClick={() => {
                    setAck(false);
                    setDeployOpen(true);
                  }}
                >
                  <RocketIcon />
                  {s.manifest ? t("deploy.redeploy") : t("set.deploy")}
                </Button>
              </div>
            </CardContent>
          </Card>
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                if (!prefs) return;
                const r = await savePrefs({ ...prefs, defaults: draft });
                if (r) toast.success(t("set.savedDefault"));
              }}
            >
              <SaveIcon />
              {t("set.saveDefault")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const d = defaultsOf();
                setDraft(s.id, d);
                setTextsState(textsOf(d));
              }}
            >
              <RotateCcwIcon />
              {t("set.resetDefault")}
            </Button>
            {checked.filter((x) => x !== s.id).length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const ids = checked.filter((x) => x !== s.id);
                  for (const id of ids) setDraft(id, draft);
                  toast.success(t("set.applied", { n: ids.length }));
                }}
              >
                <CopyCheckIcon />
                {t("set.applyChecked")}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* 表单 */}
      <SettingsForm value={draft} onChange={update} info={s.info} texts={texts} setTexts={setTexts} errors={errors} />

      <PlanDialog
        open={planOpen}
        onOpenChange={setPlanOpen}
        proxies={proxies}
        edited={!!edits}
        requireAuth={draft.auth.mode !== "none"}
        onApply={(rows) => rows && setEdits(s.id, rows, planKey)}
        onReset={() => setEdits(s.id, null)}
      />

      <ConfirmDialog
        open={deployOpen}
        onOpenChange={setDeployOpen}
        title={t("deploy.confirmTitle", { host: s.name || s.host })}
        desc={t("deploy.confirmDesc")}
        confirmText={
          <>
            <RocketIcon />
            {t("deploy.start")}
          </>
        }
        destructive={dangerNoAuth}
        disabled={dangerNoAuth && !ack}
        onConfirm={() => void deploy()}
      >
        <div className="grid gap-3">
          <SettingsSummary
            settings={draft}
            extra={[
              [t("deploy.proxies"), <span className="tabular">{proxies.length}</span>],
              [t("deploy.ips"), <span className="tabular">{ipsCount}</span>],
              ...(plan?.ports?.length ? ([[t("set.summaryPorts"), plan.ports.join("；")]] as [string, string][]) : []),
            ]}
          />
          {edits && (
            <Callout tone="info" icon={<ClipboardCheckIcon />}>
              {t("deploy.usingEdited")}
            </Callout>
          )}
          {dangerNoAuth && (
            <Callout tone="danger" icon={<AlertTriangleIcon />}>
              <div className="grid gap-2">
                <span>{t("set.auth.noneConfirmDesc")}</span>
                <Label className="cursor-pointer font-normal">
                  <Checkbox checked={ack} onCheckedChange={(v) => setAck(v === true)} />
                  {t("set.auth.noneConfirmTitle")}
                </Label>
              </div>
            </Callout>
          )}
          <Callout tone="muted">{t("deploy.sgHint")}</Callout>
        </div>
      </ConfirmDialog>
    </div>
  );
}
