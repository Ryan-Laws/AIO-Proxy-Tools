import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  CheckCheckIcon,
  CheckIcon,
  CircleDashedIcon,
  FilterIcon,
  ListRestartIcon,
  NetworkIcon,
  PlusIcon,
  SearchIcon,
  ShuffleIcon,
  XIcon,
  RadarIcon,
} from "lucide-react";
import type { Addr, ServerView } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Tip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/common";
import { detect, setSelection, setTab, useApp } from "@/store/store";
import { compareIP, subnetKey } from "@/lib/ip";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { ManualAddDialog } from "./ManualAddDialog";

const EMPTY: string[] = [];
const COLS = "grid-cols-[36px_76px_minmax(190px,1.3fr)_minmax(170px,1fr)_56px_70px_72px_76px]";

export function IpTab({ s, busy }: { s: ServerView; busy: boolean }) {
  const selected = useApp((st) => st.selection[s.id] ?? st.servers[s.id]?.selected ?? EMPTY);
  const [q, setQ] = React.useState("");
  const [subnet, setSubnet] = React.useState<string>("");
  const [manual, setManual] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const lastIdx = React.useRef<number | null>(null);

  const addrs = React.useMemo(() => [...(s.info?.addrs ?? [])].sort((a, b) => (a.family - b.family) || compareIP(a.ip, b.ip)), [s.info?.addrs]);
  const selSet = React.useMemo(() => new Set(selected), [selected]);

  const groups = React.useMemo(() => {
    const m = new Map<string, { key: string; total: number; ips: string[] }>();
    for (const a of addrs) {
      const k = subnetKey(a.ip);
      const g = m.get(k) ?? { key: k, total: 0, ips: [] };
      g.total++;
      g.ips.push(a.ip);
      m.set(k, g);
    }
    return [...m.values()];
  }, [addrs]);

  const rows = React.useMemo(() => {
    const ql = q.trim().toLowerCase();
    return addrs.filter(
      (a) =>
        (!subnet || subnetKey(a.ip) === subnet) &&
        (!ql || a.ip.toLowerCase().includes(ql) || a.public.toLowerCase().includes(ql) || a.iface.toLowerCase().includes(ql)),
    );
  }, [addrs, q, subnet]);

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 38,
    overscan: 16,
  });

  const apply = (next: Set<string>) => setSelection(s.id, addrs.filter((a) => next.has(a.ip)).map((a) => a.ip));

  /** 在当前可见行内操作，不影响被筛选掉的行 */
  const visible = rows.map((a) => a.ip);
  const selectWhere = (pred: (a: Addr) => boolean) => {
    const next = new Set(selSet);
    for (const a of rows) {
      if (pred(a)) next.add(a.ip);
      else next.delete(a.ip);
    }
    apply(next);
  };

  const toggle = (idx: number, shift: boolean) => {
    const a = rows[idx];
    const next = new Set(selSet);
    const on = !selSet.has(a.ip);
    if (shift && lastIdx.current !== null) {
      const [from, to] = [Math.min(lastIdx.current, idx), Math.max(lastIdx.current, idx)];
      for (let k = from; k <= to; k++) {
        if (on) next.add(rows[k].ip);
        else next.delete(rows[k].ip);
      }
    } else if (on) next.add(a.ip);
    else next.delete(a.ip);
    lastIdx.current = idx;
    apply(next);
  };

  if (!s.info) {
    return (
      <EmptyState icon={<RadarIcon />} title={t("ws.notDetected")} desc={t("ws.notDetectedDesc")}>
        <Button
          disabled={busy}
          onClick={() => {
            void detect(s.id);
            setTab(s.id, "logs");
          }}
        >
          <RadarIcon />
          {t("ws.startDetect")}
        </Button>
      </EmptyState>
    );
  }

  const visibleSel = visible.filter((ip) => selSet.has(ip)).length;
  const headState = visibleSel === 0 ? false : visibleSel === visible.length ? true : "indeterminate";
  const v4 = addrs.filter((a) => a.family === 4).length;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4 md:px-6">
      {/* 工具栏 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" onClick={() => selectWhere(() => true)}>
            <CheckCheckIcon />
            {t("ips.selectAll")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const next = new Set(selSet);
              for (const ip of visible) {
                if (next.has(ip)) next.delete(ip);
                else next.add(ip);
              }
              apply(next);
            }}
          >
            <ShuffleIcon />
            {t("ips.invert")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => selectWhere((a) => a.family === 4)} disabled={!v4}>
            {t("ips.onlyV4")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => selectWhere((a) => a.family === 6)} disabled={v4 === addrs.length}>
            {t("ips.onlyV6")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => selectWhere((a) => a.probe === "ok")}>
            <CheckIcon />
            {t("ips.onlyOk")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => apply(new Set())}>
            <ListRestartIcon />
            {t("ips.clear")}
          </Button>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant={subnet ? "secondary" : "outline"}>
                <NetworkIcon />
                <span className="max-w-40 truncate">{subnet || t("ips.subnet")}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-80 w-72">
              <DropdownMenuItem onSelect={() => setSubnet("")}>
                <FilterIcon />
                {t("ips.subnetAll")}
                <span className="ml-auto text-xs text-muted-foreground tabular">{addrs.length}</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t("ips.subnet")}</DropdownMenuLabel>
              {groups.map((g) => {
                const sel = g.ips.filter((ip) => selSet.has(ip)).length;
                return (
                  <div key={g.key} className="flex items-center gap-1 pr-1">
                    <DropdownMenuItem className="flex-1 font-mono text-xs" onSelect={() => setSubnet(g.key)}>
                      {g.key}
                      <span className="ml-auto font-sans text-muted-foreground tabular">
                        {sel}/{g.total}
                      </span>
                    </DropdownMenuItem>
                    <Tip content={t("ips.selectSubnet")}>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="size-6"
                        aria-label={t("ips.selectSubnet")}
                        onClick={() => {
                          const next = new Set(selSet);
                          const all = g.ips.every((ip) => next.has(ip));
                          for (const ip of g.ips) {
                            if (all) next.delete(ip);
                            else next.add(ip);
                          }
                          apply(next);
                        }}
                      >
                        <CheckCheckIcon />
                      </Button>
                    </Tip>
                  </div>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("ips.searchPh")}
              aria-label={t("ips.searchPh")}
              className="h-8 w-44 pl-8 text-[13px]"
            />
            {q && (
              <button className="absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer text-muted-foreground" onClick={() => setQ("")} aria-label={t("ips.clear")}>
                <XIcon className="size-3.5" />
              </button>
            )}
          </div>
          <Button size="sm" onClick={() => setManual(true)} disabled={busy}>
            <PlusIcon />
            {t("ips.manual")}
          </Button>
        </div>
      </div>

      {s.info.anyIP && s.info.anyIP.length > 0 && (
        <div className="-mt-1 text-xs text-muted-foreground">{t("ips.anyipBlocks", { list: s.info.anyIP.join(", ") })}</div>
      )}

      {/* 表格 */}
      <div className="flex min-h-[320px] flex-1 flex-col overflow-hidden rounded-xl border bg-card">
        <div ref={scrollRef} className="min-h-[260px] flex-1 overflow-auto scrollbar-thin" role="grid" aria-rowcount={rows.length} aria-label={t("tab.ips")}>
          <div className="min-w-[740px]">
            <div className={cn("sticky top-0 z-10 grid items-center border-b bg-muted/80 px-1 text-xs font-medium text-muted-foreground backdrop-blur", COLS)} role="row">
              <div className="flex h-9 items-center justify-center">
                <Checkbox
                  aria-label={t("ips.selectAll")}
                  checked={headState}
                  onCheckedChange={() => selectWhere(() => headState !== true)}
                />
              </div>
              <div className="px-2">{t("ips.col.iface")}</div>
              <div className="px-2">{t("ips.col.ip")}</div>
              <div className="px-2">{t("ips.col.public")}</div>
              <div className="px-2">{t("ips.col.family")}</div>
              <div className="px-2">{t("ips.col.source")}</div>
              <div className="px-2 text-center">{t("ips.col.probe")}</div>
              <div className="px-2" />
            </div>
            {rows.length === 0 ? (
              <div className="py-16 text-center text-sm text-muted-foreground">{addrs.length ? t("ips.empty") : t("ips.none")}</div>
            ) : (
              <div style={{ height: virt.getTotalSize(), position: "relative" }}>
                {virt.getVirtualItems().map((vi) => {
                  const a = rows[vi.index];
                  return (
                    <IpRow
                      key={a.ip}
                      a={a}
                      checked={selSet.has(a.ip)}
                      style={{ transform: `translateY(${vi.start}px)`, height: vi.size }}
                      onToggle={(shift) => toggle(vi.index, shift)}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 border-t bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground tabular">{t("ips.count", { sel: selected.length, total: addrs.length })}</span>
          {rows.length !== addrs.length && <span className="tabular">{t("ips.filtered", { n: rows.length })}</span>}
          <span className="hidden sm:inline">{t("ips.shiftHint")}</span>
        </div>
      </div>

      <ManualAddDialog open={manual} onOpenChange={setManual} serverId={s.id} />
    </div>
  );
}

const srcVariant: Record<string, "muted" | "info" | "primary"> = { nic: "muted", anyip: "info", manual: "primary" };

const IpRow = React.memo(function IpRow({
  a,
  checked,
  style,
  onToggle,
}: {
  a: Addr;
  checked: boolean;
  style: React.CSSProperties;
  onToggle: (shift: boolean) => void;
}) {
  const nat = a.public && a.public !== a.ip;
  return (
    <div
      role="row"
      aria-selected={checked}
      className={cn(
        "absolute top-0 left-0 grid w-full cursor-pointer items-center border-b border-border/60 px-1 text-[13px] transition-colors hover:bg-muted/50",
        COLS,
        checked && "bg-primary/[0.045] hover:bg-primary/[0.08]",
      )}
      style={style}
      onClick={(e) => onToggle(e.shiftKey)}
    >
      <div className="flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={checked}
          aria-label={a.ip}
          onClick={(e) => {
            e.preventDefault();
            onToggle(e.shiftKey);
          }}
        />
      </div>
      <div className="truncate px-2 font-mono text-xs text-muted-foreground">{a.iface || "–"}</div>
      <div className="truncate px-2 font-mono">
        {a.ip}
        <span className="text-muted-foreground">/{a.prefix}</span>
      </div>
      <div className="flex min-w-0 items-center gap-1.5 px-2 font-mono">
        {a.public ? (
          <>
            <span className={cn("truncate", nat && "text-info")}>{a.public}</span>
            {nat && (
              <Tip content={t("ips.natTip", { pub: a.public })}>
                <Badge variant="info">{t("ips.nat")}</Badge>
              </Tip>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">–</span>
        )}
      </div>
      <div className="px-2">
        <Badge variant={a.family === 6 ? "primary" : "outline"}>v{a.family}</Badge>
      </div>
      <div className="px-2">
        <Badge variant={srcVariant[a.source] ?? "muted"}>{t(`ips.src.${a.source}` as "ips.src.nic") || a.source}</Badge>
      </div>
      <div className="flex justify-center px-2">
        {a.probe === "ok" ? (
          <Tip content={t("ips.probe.ok")}>
            <CheckIcon className="size-4 text-success" aria-label={t("ips.probe.ok")} />
          </Tip>
        ) : a.probe === "fail" ? (
          <Tip content={t("ips.probe.fail")}>
            <XIcon className="size-4 text-destructive" aria-label={t("ips.probe.fail")} />
          </Tip>
        ) : (
          <Tip content={t("ips.probe.none")}>
            <CircleDashedIcon className="size-3.5 text-muted-foreground" aria-label={t("ips.probe.none")} />
          </Tip>
        )}
      </div>
      <div className="px-2">
        {a.needBind && (
          <Tip content={t("ips.needBindTip")}>
            <Badge variant="warning">{t("ips.needBind")}</Badge>
          </Tip>
        )}
      </div>
    </div>
  );
});
