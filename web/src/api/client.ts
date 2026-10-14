import { t } from "@/i18n";
import type {
  BatchAction,
  BatchResult,
  Meta,
  ParseDefaults,
  ParseResult,
  PlanRequest,
  PlanResult,
  Preferences,
  ServerEvent,
  ServerInput,
  ServerView,
  ServiceAction,
  Settings,
  TaskRef,
  TaskView,
  TestWhere,
  VaultState,
} from "./types";

// ---------- 令牌与模式 ----------

const TOKEN_KEY = "aio-token";

function detectMock(): boolean {
  const q = new URLSearchParams(location.search).get("mock");
  if (q === "1" || q === "empty" || q === "demo") return true;
  if (q === "0") return false;
  try {
    if (sessionStorage.getItem("aio-mock") === "1") return true;
  } catch {
    /* ignore */
  }
  return __MOCK_DEFAULT__;
}

export const isMock = detectMock();
try {
  if (isMock) sessionStorage.setItem("aio-mock", "1");
} catch {
  /* ignore */
}

/** 读取 ?t= 令牌，存入 sessionStorage，并从地址栏移除 */
function initToken(): string {
  const url = new URL(location.href);
  const t = url.searchParams.get("t");
  if (t) {
    try {
      sessionStorage.setItem(TOKEN_KEY, t);
    } catch {
      /* ignore */
    }
    url.searchParams.delete("t");
    history.replaceState(null, "", url.pathname + (url.search ? url.search : "") + url.hash);
    return t;
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

const token = initToken();

export function hasToken(): boolean {
  return isMock || !!token;
}

// ---------- 请求 ----------

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type MockModule = typeof import("./mock");
let mockMod: Promise<MockModule> | null = null;
function mock(): Promise<MockModule> {
  if (!mockMod) mockMod = import("./mock");
  return mockMod;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (isMock) {
    const m = await mock();
    const r = await m.mockFetch(method, path, body === undefined ? undefined : JSON.parse(JSON.stringify(body)));
    if (r.status >= 400) throw new ApiError((r.body as { error?: string })?.error ?? `HTTP ${r.status}`, r.status);
    return r.body as T;
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: {
        "X-Token": token,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(t("err.noConn"), 0);
  }
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }
  if (!res.ok) {
    const msg =
      (data as { error?: string } | undefined)?.error ??
      (res.status === 401 || res.status === 403 ? t("err.badToken") : t("err.http", { status: res.status }));
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  meta: () => request<Meta>("GET", "/api/meta"),
  putPrefs: (p: Preferences) => request<Preferences>("PUT", "/api/prefs", p),

  vaultCreate: (password: string) => request<VaultState>("POST", "/api/vault/create", { password }),
  vaultUnlock: (password: string) => request<VaultState>("POST", "/api/vault/unlock", { password }),
  vaultLock: () => request<VaultState>("POST", "/api/vault/lock"),
  vaultReset: () => request<unknown>("POST", "/api/vault/reset"),

  servers: () => request<ServerView[]>("GET", "/api/servers"),
  addServers: (servers: ServerInput[]) => request<ServerView[]>("POST", "/api/servers", { servers }),
  parseServers: (text: string, defaults: ParseDefaults) =>
    request<ParseResult>("POST", "/api/servers/parse", { text, defaults }),
  patchServer: (id: string, input: ServerInput) => request<ServerView>("PATCH", `/api/servers/${enc(id)}`, input),
  removeServer: (id: string) => request<unknown>("DELETE", `/api/servers/${enc(id)}`),
  putSelected: (id: string, selected: string[]) =>
    request<ServerView>("PUT", `/api/servers/${enc(id)}/selected`, { selected }),

  detect: (id: string, trustNewKey = false) =>
    request<TaskRef>("POST", `/api/servers/${enc(id)}/detect`, trustNewKey ? { trustNewKey } : {}),
  probe: (id: string, addrs: string[], bind: boolean) =>
    request<TaskRef>("POST", `/api/servers/${enc(id)}/probe`, { addrs, bind }),
  deploy: (id: string, req: PlanRequest) => request<TaskRef>("POST", `/api/servers/${enc(id)}/deploy`, req),
  test: (id: string, where: TestWhere) => request<TaskRef>("POST", `/api/servers/${enc(id)}/test`, { where }),
  refresh: (id: string) => request<TaskRef>("POST", `/api/servers/${enc(id)}/refresh`),
  service: (id: string, action: ServiceAction) =>
    request<TaskRef>("POST", `/api/servers/${enc(id)}/service`, { action }),
  uninstall: (id: string) => request<TaskRef>("POST", `/api/servers/${enc(id)}/uninstall`),
  plan: (id: string, req: PlanRequest) => request<PlanResult>("POST", `/api/servers/${enc(id)}/plan`, req),

  batch: (action: BatchAction, ids: string[], settings?: Settings) =>
    request<BatchResult>("POST", "/api/batch", { action, ids, ...(settings ? { settings } : {}) }),

  task: (id: string) => request<TaskView>("GET", `/api/tasks/${enc(id)}`),
  cancelTask: (id: string) => request<unknown>("POST", `/api/tasks/${enc(id)}/cancel`),
};

// ---------- 事件流 ----------

export type ConnState = "connecting" | "open" | "error";

/** 订阅 SSE；返回取消函数。EventSource 自带断线重连，这里额外处理被关闭的情况。 */
export function connectEvents(onEvent: (e: ServerEvent) => void, onState: (s: ConnState) => void): () => void {
  if (isMock) {
    let off: (() => void) | null = null;
    let closed = false;
    onState("connecting");
    void mock().then((m) => {
      if (closed) return;
      off = m.mockSubscribe(onEvent);
      onState("open");
    });
    return () => {
      closed = true;
      off?.();
    };
  }

  let es: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let retry = 1000;

  const open = () => {
    onState("connecting");
    es = new EventSource(`/api/events?t=${enc(token)}`);
    es.onopen = () => {
      retry = 1000;
      onState("open");
    };
    es.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data) as ServerEvent);
      } catch {
        /* 忽略非 JSON 数据（如心跳） */
      }
    };
    es.onerror = () => {
      onState("error");
      if (es && es.readyState === EventSource.CLOSED && !closed) {
        es = null;
        timer = setTimeout(open, retry);
        retry = Math.min(retry * 2, 15000);
      }
    };
  };
  open();
  return () => {
    closed = true;
    clearTimeout(timer);
    es?.close();
  };
}
