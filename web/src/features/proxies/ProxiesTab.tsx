import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  DownloadIcon,
  EyeIcon,
  EyeOffIcon,
  FlaskConicalIcon,
  PackageOpenIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { api } from "@/api/client";
import type { Proxy, ServerView, Stat, TestResult, TestWhere } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Tip } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { CopyButton, EmptyState } from "@/components/common";
import { noteTask, run, setTab } from "@/store/store";
import { testsByProxy } from "@/lib/export";
import { fmtDateTime, fmtMB, isExpired, limitsSummary, relTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { protoLabel } from "@/features/deploy/PlanDialog";
import { ExportDialog } from "@/features/export/ExportDialog";
import { t } from "@/i18n";

const COLS =
  "grid-cols-[minmax(170px,1.3fr)_72px_64px_minmax(96px,0.8fr)_minmax(150px,1fr)_minmax(130px,1fr)_150px_170px_minmax(120px,1fr)_92px]";

function statFor(stats: Stat[], p: Proxy): Stat | undefined {
  return stats.find((s) => s.slot === p.slot && (!s.user || s.user === p.user)) ?? stats.find((s) => s.user && s.user === p.user);
}

export function ProxiesTab({ s, busy }: { s: ServerView; busy: boolean }) {
  const [showPass, setShowPass] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [exportOpen, setExportOpen] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const proxies = React.useMemo(() => s.manifest?.proxies ?? [], [s.manifest]);
  const tm = React.useMemo(() => testsByProxy(s.tests), [s.tests]);
  const stats = s.stats ?? [];

  const rows = React.useMemo(() => {
    const ql = q.trim().toLowerCase();
    if (!ql) return proxies;
    return proxies.filter((p) => p.public.includes(ql) || p.listen.includes(ql) || p.user.toLowerCase().includes(ql) || String(p.port) === ql);
  }, [proxies, q]);

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 46,
    overscan: 12,
  });

  const summary = React.useMemo(() => {
    let ok = 0;
    let fail = 0;
    let un = 0;
    for (const p of proxies) {
      const x = tm.get(p.id);
      const r = x?.local ?? x?.remote;
      if (!r) un++;
      else if (r.ok) ok++;
      else fail++;
    }
    return { ok, fail, un };
  }, [proxies, tm]);

  if (!s.manifest || !proxies.length) {
    return (
      <EmptyState icon={<PackageOpenIcon />} title={t("px.empty")} desc={t("px.emptyD")}>
        <Button onClick={() => setTab(s.id, "settings")}>{t("px.goSettings")}</Button>
      </EmptyState>
    );
  }

  const retest = async (where: TestWhere) => {
    const r = await run(api.test(s.id, where));
    noteTask(s.id, r?.taskId, "test");
  };
  const refresh = async () => {
    const r = await run(api.refresh(s.id));
    noteTask(s.id, r?.taskId, "refresh");
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4 md:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" disabled={busy}>
              <FlaskConicalIcon />
              {t("px.retest")}
              <ChevronDownIcon className="opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => void retest("local")}>{t("px.test.local")}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void retest("server")}>{t("px.test.server")}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void retest("both")}>{t("px.test.both")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh()}>
          <RefreshCwIcon />
          {t("px.refreshStats")}
        </Button>
        <div className="flex items-center gap-2 px-1">
          <Switch id="px-showpass" checked={showPass} onCheckedChange={setShowPass} />
          <Label htmlFor="px-showpass" className="cursor-pointer text-[13px] font-normal">
            {t("px.showPass")}
          </Label>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("px.searchPh")} aria-label={t("px.searchPh")} className="h-8 w-44 pl-8 text-[13px]" />
          </div>
          <Button size="sm" onClick={() => setExportOpen(true)}>
            <DownloadIcon />
            {t("px.export")}
          </Button>
        </div>
      </div>

      <div className="flex min-h-[320px] flex-1 flex-col overflow-hidden rounded-xl border bg-card">
        <div ref={scrollRef} className="min-h-[260px] flex-1 overflow-auto scrollbar-thin" role="grid" aria-rowcount={rows.length} aria-label={t("tab.proxies")}>
          <div className="min-w-[1200px]">
            <div className={cn("sticky top-0 z-10 grid h-9 items-center border-b bg-muted/80 px-2 text-xs font-medium text-muted-foreground backdrop-blur", COLS)} role="row">
              <div className="px-2">{t("px.col.addr")}</div>
              <div className="px-2">{t("px.col.proto")}</div>
              <div className="px-2">{t("px.col.port")}</div>
              <div className="px-2">{t("px.col.user")}</div>
              <div className="px-2">{t("px.col.pass")}</div>
              <div className="px-2">{t("px.col.egress")}</div>
              <div className="px-2">{t("px.col.test")}</div>
              <div className="px-2">{t("px.col.traffic")}</div>
              <div className="px-2">{t("px.col.limits")}</div>
              <div className="px-2">{t("px.col.expires")}</div>
            </div>
            <div style={{ height: virt.getTotalSize(), position: "relative" }}>
              {virt.getVirtualItems().map((vi) => {
                const p = rows[vi.index];
                const x = tm.get(p.id);
                return (
                  <ProxyRow
                    key={p.id}
                    p={p}
                    local={x?.local}
                    remote={x?.remote}
                    stat={statFor(stats, p)}
                    showPass={showPass}
                    style={{ transform: `translateY(${vi.start}px)`, height: vi.size }}
                  />
                );
              })}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <span className="tabular">{t("px.summary", { n: proxies.length, ok: summary.ok, fail: summary.fail, un: summary.un })}</span>
          <span title={fmtDateTime(s.manifest.updatedAt)}>{t("px.updated", { t: relTime(s.manifest.updatedAt) })}</span>
        </div>
      </div>

      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} fixedIds={[s.id]} />
    </div>
  );
}

function TestBadge({ r, label }: { r: TestResult; label: string }) {
  const mismatch = r.ok && r.expected && r.egress && r.egress !== r.expected;
  const tip = (
    <div className="grid gap-0.5">
      <div>
        {label}：{r.ok ? "OK" : "FAIL"} {r.latencyMs ? `· ${r.latencyMs} ms` : ""}
      </div>
      {r.error && <div>{r.error}</div>}
      {mismatch && <div>{t("px.egressMismatch", { exp: r.expected })}</div>}
      {r.authOK === true && <div>{t("px.authOK")}</div>}
      {r.authOK === false && <div>{t("px.authBad")}</div>}
    </div>
  );
  return (
    <Tip content={tip}>
      <Badge variant={!r.ok ? "destructive" : mismatch || r.authOK === false ? "warning" : "success"} tabIndex={0} className="tabular">
        {label} {r.ok ? (r.latencyMs ? `${r.latencyMs}ms` : "✓") : "✗"}
      </Badge>
    </Tip>
  );
}

const ProxyRow = React.memo(function ProxyRow({
  p,
  local,
  remote,
  stat,
  showPass,
  style,
}: {
  p: Proxy;
  local?: TestResult;
  remote?: TestResult;
  stat?: Stat;
  showPass: boolean;
  style: React.CSSProperties;
}) {
  const [reveal, setReveal] = React.useState(false);
  const visible = showPass || reveal;
  const egress = local?.egress || remote?.egress || "";
  const expected = local?.expected || remote?.expected || p.public;
  const mismatch = !!egress && egress !== expected;
  const sg = local && !local.ok && remote?.ok;
  const limitMB = stat?.limitMB || p.limits.quotaGB * 1024;
  const used = stat?.usedMB ?? 0;
  const pct = limitMB > 0 ? Math.min(100, (used / limitMB) * 100) : 0;
  const expired = isExpired(p.limits.expiresAt);
  const authNone = !p.user;

  return (
    <div role="row" className={cn("group absolute top-0 left-0 grid w-full items-center border-b border-border/60 px-2 text-[13px] hover:bg-muted/40", COLS)} style={style}>
      <div className="min-w-0 px-2">
        <div className="flex items-center gap-1 font-mono">
          <span className="truncate">{p.public}</span>
          <CopyButton text={p.public} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" />
        </div>
        {p.listen !== p.public && <div className="truncate font-mono text-[11px] text-muted-foreground">{t("px.listen", { ip: p.listen })}</div>}
      </div>
      <div className="px-2">
        <Badge variant={p.protocol === "http" ? "info" : p.protocol === "auto" ? "warning" : "primary"}>{protoLabel(p.protocol)}</Badge>
      </div>
      <div className="px-2 font-mono tabular">{p.port}</div>
      <div className="flex min-w-0 items-center gap-1 px-2 font-mono text-xs">
        {authNone ? (
          <Badge variant="destructive">
            <ShieldAlertIcon />
            {t("set.auth.none")}
          </Badge>
        ) : (
          <span className="truncate">{p.user}</span>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-0.5 px-2 font-mono text-xs">
        {!authNone && (
          <>
            <span className={cn("truncate", !visible && "tracking-widest text-muted-foreground")}>{visible ? p.pass : "••••••••"}</span>
            <button
              className="ml-auto flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setReveal((v) => !v)}
              aria-label={visible ? t("common.hide") : t("common.show")}
            >
              {visible ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
            </button>
            <CopyButton text={p.pass} />
          </>
        )}
      </div>
      <div className={cn("truncate px-2 font-mono text-xs", mismatch ? "text-destructive" : egress ? "" : "text-muted-foreground")} title={mismatch ? t("px.egressMismatch", { exp: expected }) : undefined}>
        {egress || "–"}
      </div>
      <div className="flex flex-wrap items-center gap-1 px-2">
        {local && <TestBadge r={local} label={t("px.local")} />}
        {remote && <TestBadge r={remote} label={t("px.server")} />}
        {!local && !remote && <span className="text-xs text-muted-foreground">{t("px.untested")}</span>}
        {sg && (
          <Tip content={t("px.sgHint")}>
            <AlertTriangleIcon className="size-3.5 text-warning" tabIndex={0} aria-label={t("px.sgHint")} />
          </Tip>
        )}
        {local?.ok && local.authOK === true && <ShieldCheckIcon className="size-3.5 text-success/70" aria-label={t("px.authOK")} />}
      </div>
      <div className="grid gap-1 px-2">
        <div className="text-xs whitespace-nowrap tabular">
          {fmtMB(used)}
          {limitMB > 0 && <span className="text-muted-foreground"> / {fmtMB(limitMB)}</span>}
        </div>
        {limitMB > 0 && (
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div className={cn("h-full rounded-full", pct >= 100 ? "bg-destructive" : pct > 80 ? "bg-warning" : "bg-primary")} style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      <div className="truncate px-2 text-xs text-muted-foreground" title={limitsSummary(p.limits)}>
        {limitsSummary(p.limits)}
      </div>
      <div className={cn("px-2 text-xs tabular", expired ? "font-medium text-destructive" : "text-muted-foreground")}>
        {p.limits.expiresAt ? (expired ? `${t("px.expired")}` : p.limits.expiresAt) : "–"}
      </div>
    </div>
  );
});
