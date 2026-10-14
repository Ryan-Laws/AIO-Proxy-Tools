import * as React from "react";
import { ClipboardListIcon, FileSpreadsheetIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, RadarIcon, ServerIcon, Trash2Icon } from "lucide-react";
import type { ServerView } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ConfirmDialog, StateBadge } from "@/components/common";
import { detect, removeServer, selectServer, setChecked, toggleChecked, useApp } from "@/store/store";
import { ui } from "@/store/ui";
import { csvToServerLines } from "@/lib/csv";
import { readFileText } from "@/lib/dom";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { BatchBar } from "./BatchBar";

export function osShort(s: ServerView): string {
  const i = s.info;
  if (!i) return "";
  const id = i.osId ? i.osId.charAt(0).toUpperCase() + i.osId.slice(1) : i.os.split(" ")[0];
  return `${id} ${i.osVersion ?? ""}`.trim();
}

export function ServerList() {
  const order = useApp((s) => s.order);
  const checked = useApp((s) => s.checked);
  const csvRef = React.useRef<HTMLInputElement>(null);

  const allChecked = order.length > 0 && checked.length === order.length;
  const some = checked.length > 0 && !allChecked;

  const onCsv = async (file?: File) => {
    if (!file) return;
    const lines = csvToServerLines(await readFileText(file));
    ui.openPaste(lines.join("\n"));
    if (csvRef.current) csvRef.current.value = "";
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="grid gap-2 p-3">
        <div className="flex gap-2">
          <Button className="flex-1" onClick={ui.openAdd}>
            <PlusIcon />
            {t("side.add")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label={t("side.paste")}>
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => ui.openPaste()}>
                <ClipboardListIcon />
                {t("side.paste")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => csvRef.current?.click()}>
                <FileSpreadsheetIcon />
                {t("side.importCsv")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <input ref={csvRef} type="file" accept=".csv,.txt,text/csv" className="hidden" onChange={(e) => void onCsv(e.target.files?.[0])} />
        </div>
      </div>

      {order.length > 0 && (
        <div className="flex items-center gap-2 px-4 pb-1.5 text-xs text-muted-foreground">
          <Checkbox
            id="srv-check-all"
            aria-label={t("side.selectAll")}
            checked={allChecked ? true : some ? "indeterminate" : false}
            onCheckedChange={(v) => setChecked(v === true ? [...order] : [])}
          />
          <label htmlFor="srv-check-all" className="cursor-pointer select-none">
            {t("side.title")} · {order.length}
          </label>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 scrollbar-thin" role="listbox" aria-label={t("side.title")}>
        {order.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground">
            <ServerIcon className="size-8 opacity-40" />
            {t("side.empty")}
          </div>
        ) : (
          order.map((id) => <ServerItem key={id} id={id} checked={checked.includes(id)} />)
        )}
      </div>

      <BatchBar />
      <p className="border-t px-4 py-2.5 text-[11px] leading-relaxed text-muted-foreground">{t("side.footer")}</p>
    </div>
  );
}

const ServerItem = React.memo(function ServerItem({ id, checked }: { id: string; checked: boolean }) {
  const s = useApp((st) => st.servers[id]);
  const selected = useApp((st) => st.selectedId === id);
  const task = useApp((st) => (s?.taskId ? st.tasks[s.taskId] : undefined));
  const [confirm, setConfirm] = React.useState(false);
  if (!s) return null;
  const running = task && task.state === "running";
  const ips = s.info?.addrs?.length ?? 0;
  const proxies = s.manifest?.proxies?.length ?? 0;
  const pct = running && task.total > 0 ? (task.done / task.total) * 100 : null;
  const title = s.name || s.host;

  return (
    <>
    <div
      role="option"
      aria-selected={selected}
      tabIndex={0}
      onClick={() => selectServer(id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          selectServer(id);
        }
      }}
      className={cn(
        "group relative mb-1 flex cursor-pointer gap-2.5 rounded-lg border border-transparent px-2.5 py-2 outline-none transition-colors",
        "hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50",
        selected && "border-border bg-card shadow-xs hover:bg-card",
      )}
    >
      {selected && <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary" />}
      <div className="pt-0.5" onClick={(e) => e.stopPropagation()}>
        <Checkbox checked={checked} onCheckedChange={(v) => toggleChecked(id, v === true)} aria-label={title} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium" title={title}>
            {title}
          </span>
          <StateBadge state={s.state} busy={!!running} className="ml-auto" />
        </div>
        {s.name && <div className="truncate font-mono text-[11px] text-muted-foreground">{s.host}{s.port !== 22 ? `:${s.port}` : ""}</div>}
        <div className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
          {s.info ? (
            <>
              <span className="truncate">{osShort(s)}</span>
              <span className="opacity-40">·</span>
              <span className="tabular">{t("side.ips", { n: ips })}</span>
              {proxies > 0 && (
                <>
                  <span className="opacity-40">·</span>
                  <span className="tabular">{t("side.proxies", { n: proxies })}</span>
                </>
              )}
            </>
          ) : (
            <span>{t("side.notDetected")}</span>
          )}
        </div>
        {running && (
          <div className="mt-1.5 grid gap-1">
            <Progress value={pct} className="h-1" />
            <div className="truncate text-[11px] text-muted-foreground">
              {task.step}
              {task.total > 0 && <span className="tabular"> · {task.done}/{task.total}</span>}
            </div>
          </div>
        )}
        {!running && s.state === "error" && s.error && (
          <div className="mt-0.5 line-clamp-2 text-[11px] text-destructive" title={s.error}>
            {s.error}
          </div>
        )}
      </div>
      <div className="absolute right-1.5 bottom-1.5 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 md:has-[[data-state=open]]:opacity-100" onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="icon-xs" className="size-6 shadow-sm" aria-label={t("side.more")}>
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={!!running} onSelect={() => void detect(id)}>
              <RadarIcon />
              {t("ws.redetect")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => ui.openEdit(s)}>
              <PencilIcon />
              {t("ws.editServer")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={() => setConfirm(true)}>
              <Trash2Icon />
              {t("side.remove")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("side.removeTitle")}
        desc={t("side.removeDesc", { name: title })}
        destructive
        confirmText={t("common.remove")}
        onConfirm={() => void removeServer(id)}
      />
    </>
  );
});
