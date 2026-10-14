import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { TableIcon, RotateCcwIcon } from "lucide-react";
import type { Proxy } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NAME_RE } from "@/store/settings";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

const COLS = "grid-cols-[44px_minmax(150px,1.2fr)_minmax(150px,1.2fr)_76px_96px_minmax(120px,1fr)_minmax(150px,1.2fr)]";

export const protoLabel = (p: string) => (p === "socks" ? "SOCKS5" : p === "http" ? "HTTP" : p === "auto" ? "AUTO" : p);

type RowErr = { port?: string; user?: string; pass?: string };

export function validateRows(rows: Proxy[], requireAuth: boolean): RowErr[] {
  const seen = new Map<string, number>();
  const errs: RowErr[] = rows.map(() => ({}));
  rows.forEach((r, i) => {
    if (!(Number.isInteger(r.port) && r.port >= 1 && r.port <= 65535)) errs[i].port = t("plan.errPort");
    const k = `${r.listen}|${r.port}`;
    if (seen.has(k)) {
      errs[i].port = t("plan.errDup");
      errs[seen.get(k)!].port = t("plan.errDup");
    } else seen.set(k, i);
    if (requireAuth || r.user || r.pass) {
      if (!r.user || !NAME_RE.test(r.user) || r.user.length > 64) errs[i].user = t("plan.errChar");
      if (!r.pass || !NAME_RE.test(r.pass)) errs[i].pass = t("plan.errChar");
      else if (r.pass.length < 6 || r.pass.length > 64) errs[i].pass = t("val.passLen");
    }
  });
  // 同一用户名只能对应一个密码（3proxy 的账号表按用户名区分）
  const passOf = new Map<string, string>();
  rows.forEach((r, i) => {
    if (!r.user) return;
    const p = passOf.get(r.user);
    if (p === undefined) passOf.set(r.user, r.pass);
    else if (p !== r.pass) errs[i].pass = t("plan.errSameUser");
  });
  return errs;
}

export function PlanDialog({
  open,
  onOpenChange,
  proxies,
  edited,
  requireAuth,
  onApply,
  onReset,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  proxies: Proxy[];
  edited: boolean;
  requireAuth: boolean;
  onApply: (rows: Proxy[] | null) => void;
  onReset: () => void;
}) {
  const [rows, setRows] = React.useState<Proxy[]>(proxies);
  const [dirty, setDirty] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const latest = React.useRef(proxies);
  latest.current = proxies;
  React.useEffect(() => {
    if (open) {
      setRows(latest.current);
      setDirty(false);
    }
  }, [open]);

  const errs = React.useMemo(() => validateRows(rows, requireAuth), [rows, requireAuth]);
  const errCount = errs.filter((e) => e.port || e.user || e.pass).length;

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 40,
    overscan: 10,
  });

  const edit = (i: number, p: Partial<Proxy>) => {
    setDirty(true);
    setRows((rs) => {
      const next = rs.slice();
      next[i] = { ...next[i], ...p };
      return next;
    });
  };

  const cellInput = "h-7 w-full rounded border border-transparent bg-transparent px-1.5 font-mono text-xs outline-none hover:border-input focus:border-ring focus:bg-card focus:ring-2 focus:ring-ring/30";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(760px,calc(100dvh-2rem))] max-w-5xl flex-col gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TableIcon className="size-5 text-primary" />
            {t("plan.title")}
            <Badge variant="secondary" className="tabular">
              {rows.length}
            </Badge>
            {errCount > 0 && <Badge variant="destructive">{t("plan.errCount", { n: errCount })}</Badge>}
          </DialogTitle>
          <DialogDescription>{t("plan.desc")}</DialogDescription>
        </DialogHeader>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto rounded-lg border scrollbar-thin">
          <div className="min-w-[820px]">
            <div className={cn("sticky top-0 z-10 grid items-center border-b bg-muted/90 px-1 text-xs font-medium text-muted-foreground backdrop-blur", COLS)}>
              <div className="px-2 py-2">#</div>
              <div className="px-2">{t("plan.col.public")}</div>
              <div className="px-2">{t("plan.col.listen")}</div>
              <div className="px-2">{t("plan.col.proto")}</div>
              <div className="px-2">{t("plan.col.port")}</div>
              <div className="px-2">{t("plan.col.user")}</div>
              <div className="px-2">{t("plan.col.pass")}</div>
            </div>
            {rows.length === 0 ? (
              <div className="py-16 text-center text-sm text-muted-foreground">{t("plan.empty")}</div>
            ) : (
              <div style={{ height: virt.getTotalSize(), position: "relative" }}>
                {virt.getVirtualItems().map((vi) => {
                  const r = rows[vi.index];
                  const e = errs[vi.index];
                  return (
                    <div
                      key={vi.key}
                      className={cn("absolute top-0 left-0 grid w-full items-center border-b border-border/60 px-1 text-[13px]", COLS)}
                      style={{ transform: `translateY(${vi.start}px)`, height: vi.size }}
                    >
                      <div className="px-2 text-xs text-muted-foreground tabular">{vi.index + 1}</div>
                      <div className="truncate px-2 font-mono text-xs">{r.public}</div>
                      <div className={cn("truncate px-2 font-mono text-xs", r.listen === r.public ? "text-muted-foreground/60" : "text-info")}>{r.listen}</div>
                      <div className="px-2">
                        <Badge variant={r.protocol === "http" ? "info" : r.protocol === "auto" ? "warning" : "primary"}>{protoLabel(r.protocol)}</Badge>
                      </div>
                      <div className="px-1" title={e.port}>
                        <input
                          aria-label={`${t("plan.col.port")} ${vi.index + 1}`}
                          className={cn(cellInput, "tabular", e.port && "border-destructive bg-destructive/5")}
                          inputMode="numeric"
                          value={r.port || ""}
                          onChange={(ev) => edit(vi.index, { port: Number(ev.target.value.replace(/\D/g, "")) || 0 })}
                        />
                      </div>
                      <div className="px-1" title={e.user}>
                        <input
                          aria-label={`${t("plan.col.user")} ${vi.index + 1}`}
                          className={cn(cellInput, e.user && "border-destructive bg-destructive/5")}
                          value={r.user}
                          onChange={(ev) => edit(vi.index, { user: ev.target.value.trim() })}
                          spellCheck={false}
                        />
                      </div>
                      <div className="px-1" title={e.pass}>
                        <input
                          aria-label={`${t("plan.col.pass")} ${vi.index + 1}`}
                          className={cn(cellInput, e.pass && "border-destructive bg-destructive/5")}
                          value={r.pass}
                          onChange={(ev) => edit(vi.index, { pass: ev.target.value.trim() })}
                          spellCheck={false}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="items-center">
          {edited && (
            <Button
              variant="ghost"
              className="mr-auto"
              onClick={() => {
                onReset();
                onOpenChange(false);
              }}
            >
              <RotateCcwIcon />
              {t("plan.reset")}
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={errCount > 0 || !rows.length}
            onClick={() => {
              onApply(dirty ? rows : null);
              onOpenChange(false);
            }}
          >
            {t("plan.apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
