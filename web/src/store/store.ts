import { create } from "zustand";
import { toast } from "sonner";
import { api, connectEvents, type ConnState } from "@/api/client";
import type {
  LogLine,
  Meta,
  Proxy,
  Preferences,
  ServerEvent,
  ServerView,
  Settings,
  TaskView,
  VaultState,
} from "@/api/types";
import { normalizeSettings, fallbackSettings } from "./settings";
import { t } from "@/i18n";

export type TabKey = "ips" | "settings" | "logs" | "proxies" | "manage";

interface AppState {
  ready: boolean;
  loadError: string | null;
  meta: Meta | null;
  prefs: Preferences | null;
  vault: VaultState;
  servers: Record<string, ServerView>;
  order: string[];
  tasks: Record<string, TaskView>;
  logs: Record<string, LogLine[]>;
  selectedId: string | null;
  checked: string[];
  conn: ConnState;
  drafts: Record<string, Settings>;
  /** 本地尚未保存到后端的 IP 勾选 */
  selection: Record<string, string[]>;
  tabs: Record<string, TabKey>;
  /** 预览表中手动修改过的清单 */
  edits: Record<string, { key: string; proxies: Proxy[] }>;
  mobileNav: boolean;
}

export const useApp = create<AppState>(() => ({
  ready: false,
  loadError: null,
  meta: null,
  prefs: null,
  vault: { exists: false, unlocked: false },
  servers: {},
  order: [],
  tasks: {},
  logs: {},
  selectedId: null,
  checked: [],
  conn: "connecting",
  drafts: {},
  selection: {},
  tabs: {},
  edits: {},
  mobileNav: false,
}));

const set = useApp.setState;
const get = useApp.getState;

// ---------- 通用 ----------

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 执行 API 调用，失败时弹出提示；返回 undefined 表示失败 */
export async function run<T>(p: Promise<T>, ok?: string): Promise<T | undefined> {
  try {
    const r = await p;
    if (ok) toast.success(ok);
    return r;
  } catch (e) {
    toast.error(errMsg(e));
    return undefined;
  }
}

// ---------- 初始化与事件 ----------

let stopEvents: (() => void) | null = null;

export async function init() {
  try {
    const [meta, servers] = await Promise.all([api.meta(), api.servers()]);
    set((s) => {
      const map = { ...s.servers };
      const order = [...s.order];
      for (const v of servers ?? []) {
        map[v.id] = v;
        if (!order.includes(v.id)) order.push(v.id);
      }
      return {
        meta,
        prefs: meta.prefs,
        vault: meta.vault,
        servers: map,
        order,
        ready: true,
        loadError: null,
        selectedId: s.selectedId ?? order[0] ?? null,
      };
    });
  } catch (e) {
    set({ loadError: errMsg(e), ready: true });
    return;
  }
  stopEvents?.();
  stopEvents = connectEvents(applyEvent, (conn) => set({ conn }));
}

const seenRunning = new Set<string>();

export function applyEvent(e: ServerEvent) {
  switch (e.type) {
    case "server": {
      const v = e.server;
      if (!v) return;
      // 服务器的任务已结束（taskId 清空或换了），但本地仍显示运行中：说明漏掉了 task 事件
      // （SSE 重连、订阅拥塞丢事件），主动拉一次最终状态和完整日志
      const oldTask = get().servers[v.id]?.taskId;
      if (oldTask && oldTask !== v.taskId && get().tasks[oldTask]?.state === "running") {
        void syncTask(oldTask);
      }
      set((s) => ({
        servers: { ...s.servers, [v.id]: v },
        order: s.order.includes(v.id) ? s.order : [...s.order, v.id],
        selectedId: s.selectedId ?? v.id,
      }));
      return;
    }
    case "server-removed": {
      const id = e.id;
      if (!id) return;
      removeLocal(id);
      return;
    }
    case "task": {
      const tk = e.task;
      if (!tk) return;
      const prev = get().tasks[tk.id];
      set((s) => ({ tasks: { ...s.tasks, [tk.id]: { ...prev, ...tk, logs: undefined } } }));
      if (tk.state === "running") seenRunning.add(tk.id);
      else if (seenRunning.has(tk.id)) {
        seenRunning.delete(tk.id);
        onTaskFinished(tk);
      }
      return;
    }
    case "log": {
      const id = e.id;
      const line = e.log;
      if (!id || !line) return;
      set((s) => ({ logs: { ...s.logs, [id]: [...(s.logs[id] ?? []), line] } }));
      return;
    }
  }
}

async function syncTask(id: string) {
  try {
    const tk = await api.task(id);
    if (tk.state === "running") return;
    const { logs, ...rest } = tk;
    set((s) => ({
      tasks: { ...s.tasks, [id]: { ...s.tasks[id], ...rest, logs: undefined } },
      logs: logs ? { ...s.logs, [id]: logs } : s.logs,
    }));
    if (seenRunning.has(id)) {
      seenRunning.delete(id);
      onTaskFinished(tk);
    }
  } catch {
    /* 任务可能已被清理，忽略 */
  }
}

function onTaskFinished(tk: TaskView) {
  const srv = get().servers[tk.serverId];
  const name = srv ? srv.name || srv.host : "";
  const kind = t(`task.kind.${tk.kind}` as never) || tk.kind;
  if (tk.state === "failed") toast.error(`${name}：${kind}${t("task.failed")}`, { description: tk.error });
  else if (tk.state === "done" && (tk.kind === "deploy" || tk.kind === "uninstall" || tk.kind === "probe"))
    toast.success(`${name}：${kind}${t("task.done")}`);
  // 自动切换标签
  const tab = get().tabs[tk.serverId];
  if (tk.state === "done" && tab === "logs") {
    if (tk.kind === "deploy") setTab(tk.serverId, "proxies");
  }
}

function removeLocal(id: string) {
  set((s) => {
    const servers = { ...s.servers };
    delete servers[id];
    const order = s.order.filter((x) => x !== id);
    const drafts = { ...s.drafts };
    delete drafts[id];
    return {
      servers,
      order,
      drafts,
      checked: s.checked.filter((x) => x !== id),
      selectedId: s.selectedId === id ? (order[0] ?? null) : s.selectedId,
    };
  });
}

// ---------- 视图状态 ----------

export function selectServer(id: string | null) {
  set({ selectedId: id, mobileNav: false });
}
export function setTab(id: string, tab: TabKey) {
  set((s) => ({ tabs: { ...s.tabs, [id]: tab } }));
}
export function setMobileNav(v: boolean) {
  set({ mobileNav: v });
}
export function toggleChecked(id: string, on?: boolean) {
  set((s) => {
    const has = s.checked.includes(id);
    const want = on ?? !has;
    if (want === has) return {};
    return { checked: want ? [...s.checked, id] : s.checked.filter((x) => x !== id) };
  });
}
export function setChecked(ids: string[]) {
  set({ checked: ids });
}

// ---------- 设置草稿 ----------

export function defaultsOf(): Settings {
  const st = get();
  return normalizeSettings(st.prefs?.defaults ?? st.meta?.defaults ?? fallbackSettings());
}

export function draftOf(id: string): Settings {
  const st = get();
  const d = st.drafts[id];
  if (d) return d;
  const srv = st.servers[id];
  const base = defaultsOf();
  if (srv?.manifest?.settings) return normalizeSettings({ ...base, ...srv.manifest.settings });
  return base;
}

export function setDraft(id: string, s: Settings) {
  set((st) => ({ drafts: { ...st.drafts, [id]: s } }));
}

export function setEdits(id: string, list: Proxy[] | null, key = "") {
  set((st) => {
    const edits = { ...st.edits };
    if (list) edits[id] = { key, proxies: list };
    else delete edits[id];
    return { edits };
  });
}

export function resetDraft(id: string) {
  set((st) => {
    const drafts = { ...st.drafts };
    delete drafts[id];
    return { drafts };
  });
}

// ---------- IP 勾选（本地优先，防抖保存） ----------

const selTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function selectionOf(id: string): string[] {
  const st = get();
  return st.selection[id] ?? st.servers[id]?.selected ?? [];
}

export function setSelection(id: string, ips: string[]) {
  set((s) => ({ selection: { ...s.selection, [id]: ips } }));
  clearTimeout(selTimers.get(id));
  selTimers.set(
    id,
    setTimeout(async () => {
      selTimers.delete(id);
      const sent = get().selection[id];
      if (!sent) return;
      try {
        const v = await api.putSelected(id, sent);
        set((s) => {
          const selection = { ...s.selection };
          if (selection[id] === sent) delete selection[id];
          return { servers: v ? { ...s.servers, [id]: v } : s.servers, selection };
        });
      } catch (e) {
        toast.error(t("ips.saveFailed") + errMsg(e));
      }
    }, 450),
  );
}

/** 立即提交未保存的勾选（部署前调用） */
export async function flushSelection(id: string) {
  const tm = selTimers.get(id);
  if (!tm) return;
  clearTimeout(tm);
  selTimers.delete(id);
  const sent = get().selection[id];
  if (!sent) return;
  try {
    await api.putSelected(id, sent);
  } catch {
    /* 部署请求里本身带 selected，忽略 */
  }
}

// ---------- 任务日志 ----------

export async function loadTaskLogs(taskId: string) {
  try {
    const full = await api.task(taskId);
    set((s) => {
      const fullLogs = full.logs ?? [];
      const last = fullLogs.length ? fullLogs[fullLogs.length - 1].t : "";
      const extra = (s.logs[taskId] ?? []).filter((l) => l.t > last);
      return {
        tasks: { ...s.tasks, [taskId]: { ...full, logs: undefined } },
        logs: { ...s.logs, [taskId]: [...fullLogs, ...extra] },
      };
    });
  } catch {
    /* 任务可能已过期 */
  }
}

// ---------- 服务器操作 ----------

export function noteTask(serverId: string, taskId: string | undefined, kind: string) {
  if (!taskId) return;
  seenRunning.add(taskId);
  set((s) => ({
    tasks: s.tasks[taskId]
      ? s.tasks
      : {
          ...s.tasks,
          [taskId]: {
            id: taskId,
            serverId,
            kind,
            state: "running",
            step: "",
            done: 0,
            total: 0,
            error: "",
            startedAt: new Date().toISOString(),
          },
        },
  }));
}

export async function removeServer(id: string) {
  const r = await run(api.removeServer(id));
  if (r !== undefined) removeLocal(id);
}

export async function detect(id: string, trustNewKey = false) {
  const r = await run(api.detect(id, trustNewKey));
  noteTask(id, r?.taskId, "detect");
  return r?.taskId;
}

export function upsertServers(list: ServerView[]) {
  set((s) => {
    const servers = { ...s.servers };
    const order = [...s.order];
    for (const v of list) {
      servers[v.id] = v;
      if (!order.includes(v.id)) order.push(v.id);
    }
    return { servers, order };
  });
}

export async function savePrefs(p: Preferences) {
  const r = await run(api.putPrefs(p));
  if (r) set({ prefs: r });
  return r;
}

export function setVault(v: VaultState) {
  set({ vault: v });
}

/** 某服务器当前正在运行的任务 */
export function useRunningTask(id: string | null | undefined): TaskView | undefined {
  return useApp((s) => {
    if (!id) return undefined;
    const tid = s.servers[id]?.taskId;
    if (!tid) return undefined;
    const tk = s.tasks[tid];
    return tk && tk.state === "running" ? tk : tk ?? undefined;
  });
}
