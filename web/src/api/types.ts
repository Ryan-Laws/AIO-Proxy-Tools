// 与 internal/model/*.go 一一对应（字段名即 JSON 名）。修改时两边同步。
// time.Time 在 JSON 中为 RFC3339 字符串。

// ---------- 服务器探测 ----------

export type AddrSource = "nic" | "anyip" | "manual";
export type ProbeState = "" | "ok" | "fail";

export interface Addr {
  ip: string;
  prefix: number;
  iface: string;
  family: 4 | 6 | number;
  source: AddrSource | string;
  /** 实测出口公网 IP，未知为空 */
  public: string;
  probe: ProbeState | string;
  /** 手动添加且不在网卡上，部署时需绑定 */
  needBind: boolean;
}

export interface ServerInfo {
  os: string;
  osId: string;
  osVersion: string;
  kernel: string;
  arch: string;
  init: string; // systemd | openrc | unknown
  pm: string;
  isRoot: boolean;
  hasCurl: boolean;
  hasWget: boolean;
  firewalls: string[] | null;
  tcpCC: string;
  memMB: number;
  cpus: number;
  installed: boolean;
  version: string;
  conflicts: string[] | null;
  defaultIface: string;
  listening: string[] | null;
  addrs: Addr[] | null;
  anyIP: string[] | null;
  warnings: string[] | null;
  detectedAt: string;
}

// ---------- 代理设置 ----------

export type Protocol = "socks" | "http" | "dual" | "auto";
export type PortMode = "same" | "inc" | "random";
export type AuthMode = "per" | "shared" | "custom" | "list" | "none";
export type QuotaPeriod = "D" | "W" | "M" | "";
export type DNSMode = "recursive" | "forward" | "public" | "system" | "custom";

export interface PortRule {
  mode: PortMode;
  port: number;
  rangeMin: number;
  rangeMax: number;
}

export interface Cred {
  user: string;
  pass: string;
}

export interface AuthRule {
  mode: AuthMode;
  user: string;
  pass: string;
  userPrefix: string;
  userLen: number;
  passLen: number;
  list: Cred[] | null;
}

/** 单个代理（账号）的限制，0 表示不限 */
export interface Limits {
  speedMbps: number;
  maxConn: number;
  quotaGB: number;
  quotaPeriod: QuotaPeriod | string;
  /** YYYY-MM-DD */
  expiresAt: string;
}

export interface DNSRule {
  mode: DNSMode;
  servers: string[] | null;
}

export interface Settings {
  protocol: Protocol;
  socks: PortRule;
  http: PortRule;
  auth: AuthRule;
  whitelist: string[] | null;
  limits: Limits;
  dns: DNSRule;
  keepExisting: boolean;
  firewall: boolean;
  bbr: boolean;
  tune: boolean;
  blockPrivate: boolean;
  udp: boolean;
  log: boolean;
  maxConn: number;
  stopConflicts: string[] | null;
  githubMirror: string;
}

// ---------- 代理清单 ----------

export type ProxyProtocol = "socks" | "http" | "auto";

export interface Proxy {
  id: string;
  listen: string;
  public: string;
  family: number;
  iface: string;
  prefix: number;
  needBind: boolean;
  protocol: ProxyProtocol | string;
  port: number;
  user: string;
  pass: string;
  slot: number;
  limits: Limits;
  whitelist: string[] | null;
}

export interface Manifest {
  version: number;
  tool: string;
  updatedAt: string;
  settings: Settings;
  proxies: Proxy[] | null;
  adminPort: number;
  adminUser: string;
  adminPass: string;
  dnsEffective: string;
}

// ---------- 测试与统计 ----------

export interface TestResult {
  proxyId: string;
  where: "local" | "server" | string;
  ok: boolean;
  egress: string;
  expected: string;
  latencyMs: number;
  authOK?: boolean | null;
  error?: string;
}

export interface Stat {
  user: string;
  slot: number;
  usedMB: number;
  limitMB: number;
  period: string;
}

export interface ServiceStatus {
  active: boolean;
  dnsActive: boolean;
  pid: number;
  threads: number;
  memMB: number;
  connections: number;
  since: string;
}

// ---------- API ----------

export type ServerState = "new" | "connecting" | "ready" | "deploying" | "deployed" | "error";
export type AuthType = "password" | "key";

export interface ServerView {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  authType: AuthType | string;
  hasSecret: boolean;
  remember: boolean;
  state: ServerState | string;
  error: string;
  info: ServerInfo | null;
  selected: string[] | null;
  manifest: Manifest | null;
  tests: TestResult[] | null;
  stats: Stat[] | null;
  status: ServiceStatus | null;
  taskId: string;
  fingerprint: string;
  updatedAt: string;
}

export interface ServerInput {
  name: string;
  host: string;
  port: number;
  user: string;
  authType: AuthType | string;
  password: string;
  key: string;
  passphrase: string;
  remember: boolean;
}

export type TaskKind = "detect" | "probe" | "deploy" | "test" | "refresh" | "service" | "uninstall";
export type TaskState = "running" | "done" | "failed" | "canceled";

export interface TaskView {
  id: string;
  serverId: string;
  kind: TaskKind | string;
  state: TaskState | string;
  step: string;
  done: number;
  total: number;
  error: string;
  logs?: LogLine[] | null;
  startedAt: string;
  endedAt?: string;
}

export type LogLevel = "info" | "ok" | "warn" | "error" | "step";

export interface LogLine {
  t: string;
  level: LogLevel | string;
  text: string;
}

export interface PlanRequest {
  settings: Settings;
  selected: string[];
  /** 预览后用户修改过的清单；为空则按 Settings 重新生成 */
  edited: Proxy[] | null;
}

export interface PlanResult {
  proxies: Proxy[] | null;
  warnings: string[] | null;
  errors: string[] | null;
  ports: string[] | null;
}

export type Theme = "system" | "light" | "dark";

export interface Preferences {
  saveHistory: boolean;
  concurrency: number;
  defaults: Settings;
  theme: Theme | string;
}

export interface ServerEvent {
  type: "server" | "server-removed" | "task" | "log" | string;
  server?: ServerView;
  task?: TaskView;
  id?: string;
  log?: LogLine;
}

// ---------- 请求/响应包装（docs/API.md） ----------

export interface VaultState {
  exists: boolean;
  unlocked: boolean;
}

export interface Meta {
  version: string;
  vault: VaultState;
  defaults: Settings;
  prefs: Preferences;
}

export interface ParseDefaults {
  port: number;
  user: string;
  authType: AuthType | string;
}

export interface ParseResult {
  servers: ServerInput[] | null;
  errors: string[] | null;
}

export type BatchAction = "detect" | "deploy" | "test" | "refresh";
export type TestWhere = "local" | "server" | "both";
export type ServiceAction = "start" | "stop" | "restart";

export interface TaskRef {
  taskId: string;
}

export interface BatchResult {
  taskIds: Record<string, string>;
}
