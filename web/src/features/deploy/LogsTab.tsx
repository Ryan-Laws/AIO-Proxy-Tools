import * as React from "react";
import { ArrowDownIcon, CheckCircle2Icon, ChevronDownIcon, CopyIcon, HistoryIcon, Loader2Icon, OctagonXIcon, ScrollTextIcon, XCircleIcon, BanIcon } from "lucide-react";
import { api } from "@/api/client";
import type { LogLine, ServerView, TaskView } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog, EmptyState } from "@/components/common";
import { loadTaskLogs, run, useApp } from "@/store/store";
import { copyText } from "@/lib/dom";
import { fmtTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { t, type MessageKey } from "@/i18n";

const EMPTY: LogLine[] = [];
const fetched = new Set<string>();

const levelCls: Record<string, string> = {
  step: "text-[oklch(0.78_0.12_270)] font-semibold",
  info: "text-console-foreground/85",
  ok: "text-[oklch(0.78_0.15_155)]",
  warn: "text-[oklch(0.83_0.14_80)]",
  error: "text-[oklch(0.72_0.18_25)]",
};
const levelTag: Record<string, string> = { step: "▶", info: "·", ok: "✓", warn: "!", error: "✗" };

export function taskStateBadge(tk: TaskView) {
  const v = tk.state === "running" ? "info" : tk.state === "done" ? "success" : tk.state === "failed" ? "destructive" : "muted";
  const icon =
    tk.state === "running" ? <Loader2Icon className="animate-spin" /> : tk.state === "done" ? <CheckCircle2Icon /> : tk.state === "failed" ? <XCircleIcon /> : <BanIcon />;
  return (
    <Badge variant={v}>
      {icon}
      {t(`task.state.${tk.state}` as MessageKey)}
    </Badge>
  );
}

export function LogsTab({ s }: { s: ServerView }) {
  const allTasks = useApp((st) => st.tasks);
  const tasks = React.useMemo(
    () => Object.values(allTasks).filter((x) => x.serverId === s.id).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)),
    [allTasks, s.id],
  );
  const [picked, setPicked] = React.useState<string | null>(null);
  // 默认显示正在运行的任务，其次最近一次任务
  const current = s.taskId || tasks[0]?.id || "";
  const taskId = picked && allTasks[picked] ? picked : current;
  React.useEffect(() => setPicked(null), [s.taskId]);

  const task = taskId ? allTasks[taskId] : undefined;
  const logs = useApp((st) => (taskId ? st.logs[taskId] : undefined)) ?? EMPTY;

  React.useEffect(() => {
    if (!taskId || fetched.has(taskId)) return;
    fetched.add(taskId);
    void loadTaskLogs(taskId);
  }, [taskId]);

  // 自动滚动
  const boxRef = React.useRef<HTMLDivElement>(null);
  const [follow, setFollow] = React.useState(true);
  const [wrap, setWrap] = React.useState(true);
  React.useLayoutEffect(() => {
    if (follow && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [logs.length, follow, taskId]);
  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setFollow(atBottom);
  };

  const [cancelOpen, setCancelOpen] = React.useState(false);

  if (!task) {
    return <EmptyState icon={<ScrollTextIcon />} title={t("log.empty")} desc={t("log.emptyD")} />;
  }

  const running = task.state === "running";
  const pct = task.total > 0 ? (task.done / task.total) * 100 : running ? null : 100;

  const text = () => logs.map((l) => `${fmtTime(l.t)} [${l.level}] ${l.text}`).join("\n");

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4 md:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="max-w-full">
              <HistoryIcon />
              <span className="truncate">
                {t(`task.kind.${task.kind}` as MessageKey)} · {fmtTime(task.startedAt)}
              </span>
              <ChevronDownIcon className="opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel>{t("log.history")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={taskId} onValueChange={setPicked}>
              {tasks.map((x) => (
                <DropdownMenuRadioItem key={x.id} value={x.id}>
                  <span className="flex-1">{t(`task.kind.${x.kind}` as MessageKey)}</span>
                  <span className="text-xs text-muted-foreground tabular">{fmtTime(x.startedAt)}</span>
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      x.state === "running" ? "bg-info" : x.state === "done" ? "bg-success" : x.state === "failed" ? "bg-destructive" : "bg-muted-foreground",
                    )}
                  />
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {taskStateBadge(task)}
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setWrap((w) => !w)} aria-pressed={wrap}>
            {t("log.wrap")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void copyText(text())} disabled={!logs.length}>
            <CopyIcon />
            {t("log.copy")}
          </Button>
          {running && (
            <Button size="sm" variant="outline" className="text-destructive" onClick={() => setCancelOpen(true)}>
              <OctagonXIcon />
              {t("log.cancel")}
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-1.5 rounded-xl border bg-card px-4 py-3">
        <div className="flex items-center justify-between gap-3 text-[13px]">
          <span className="flex min-w-0 items-center gap-2 font-medium">
            {running && <Loader2Icon className="size-4 shrink-0 animate-spin text-primary" />}
            <span className="truncate">{task.step || t(`task.state.${task.state}` as MessageKey)}</span>
          </span>
          {task.total > 0 && (
            <span className="shrink-0 text-xs text-muted-foreground tabular">
              {task.done} / {task.total}
            </span>
          )}
        </div>
        <Progress
          value={pct}
          className="h-2"
          indicatorClassName={task.state === "failed" ? "bg-destructive" : task.state === "done" ? "bg-success" : task.state === "canceled" ? "bg-muted-foreground" : undefined}
        />
        {task.state === "failed" && task.error && <p className="text-xs text-destructive">{task.error}</p>}
      </div>

      <div className="relative min-h-[300px] flex-1 overflow-hidden rounded-xl border bg-console shadow-inner">
        <div
          ref={boxRef}
          onScroll={onScroll}
          className={cn("absolute inset-0 overflow-auto p-3 font-mono text-[12.5px] leading-[1.65] text-console-foreground scrollbar-thin", wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre")}
          role="log"
          aria-live="polite"
          aria-label={t("log.title")}
        >
          {logs.length === 0 ? (
            <div className="flex items-center gap-2 text-console-foreground/50">
              <Loader2Icon className="size-3.5 animate-spin" />
              {t("common.loading")}
            </div>
          ) : (
            logs.map((l, i) => (
              <div key={i} className={cn("flex gap-3", l.level === "step" && i > 0 && "mt-1.5")}>
                <span className="shrink-0 text-console-foreground/35 select-none tabular">{fmtTime(l.t)}</span>
                <span className={cn("w-3 shrink-0 text-center select-none", levelCls[l.level])}>{levelTag[l.level] ?? "·"}</span>
                <span className={cn("min-w-0", levelCls[l.level] ?? levelCls.info)}>{l.text}</span>
              </div>
            ))
          )}
        </div>
        {!follow && (
          <Button
            size="xs"
            variant="secondary"
            className="absolute right-4 bottom-3 shadow-lg"
            onClick={() => {
              setFollow(true);
              if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
            }}
          >
            <ArrowDownIcon />
            {t("log.paused")} · {t("log.resume")}
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={t("log.cancelTitle")}
        desc={t("log.cancelDesc")}
        destructive
        confirmText={t("log.cancel")}
        onConfirm={() => void run(api.cancelTask(task.id))}
      />
    </div>
  );
}
