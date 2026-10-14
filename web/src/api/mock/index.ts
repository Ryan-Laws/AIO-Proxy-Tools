// 内存版假后端：模拟 /api/* 与 SSE，用于无后端时开发和演示。
// 规则：主机名包含 fail → 认证失败；包含 key → 主机密钥变化；包含 nat/anyip/multi/single → 对应网络形态。
import type {
  Addr,
  LogLine,
  Manifest,
  Meta,
  ParseResult,
  PlanRequest,
  Preferences,
  Proxy,
  ServerEvent,
  ServerInput,
  ServerView,
  Settings,
  Stat,
  TaskView,
  TestResult,
  VaultState,
} from "../types";
import { buildInfo, defaultSettings, expandSpec, probeAddr } from "./data";
import { makePlan } from "./plan";
import { rng, sleep, uid } from "./rand";
import { isValidIP } from "@/lib/ip";

type Srv = ServerView & { secret: boolean; trusted: boolean; detectCount: number };

const servers = new Map<string, Srv>();
const tasks = new Map<string, TaskView & { logs: LogLine[]; cancel: boolean }>();
const subs = new Set<(e: ServerEvent) => void>();
let prefs: Preferences = { saveHistory: true, concurrency: 3, defaults: defaultSettings(), theme: "system" };
const vault: VaultState & { password: string } = { exists: false, unlocked: false, password: "" };

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function emit(e: ServerEvent) {
  const c = clone(e);
  subs.forEach((fn) => fn(c));
}

function view(s: Srv): ServerView {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { secret, trusted, detectCount, ...v } = s;
  return clone({ ...v, hasSecret: secret });
}

function pushServer(s: Srv) {
  s.updatedAt = new Date().toISOString();
  emit({ type: "server", server: view(s) });
}

function taskView(t: TaskView & { logs: LogLine[]; cancel: boolean }, withLogs = false): TaskView {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { logs, cancel, ...rest } = t;
  return withLogs ? clone({ ...rest, logs }) : clone(rest);
}

export function mockSubscribe(fn: (e: ServerEvent) => void): () => void {
  subs.add(fn);
  setTimeout(() => {
    for (const s of servers.values()) fn(clone({ type: "server", server: view(s) }));
    for (const t of tasks.values()) if (t.state === "running") fn({ type: "task", task: taskView(t) });
  }, 30);
  return () => subs.delete(fn);
}

// ---------- 任务引擎 ----------

class Canceled extends Error {}

class Ctx {
  constructor(
    public t: TaskView & { logs: LogLine[]; cancel: boolean },
    public s: Srv,
  ) {}
  log(level: string, text: string) {
    const l: LogLine = { t: new Date().toISOString(), level, text };
    this.t.logs.push(l);
    emit({ type: "log", id: this.t.id, log: l });
  }
  step(step: string, done?: number, total?: number) {
    this.t.step = step;
    if (done !== undefined) this.t.done = done;
    if (total !== undefined) this.t.total = total;
    emit({ type: "task", task: taskView(this.t) });
    this.log("step", step);
  }
  progress(done: number, total?: number) {
    this.t.done = done;
    if (total !== undefined) this.t.total = total;
    emit({ type: "task", task: taskView(this.t) });
  }
  async sleep(ms: number) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (this.t.cancel) throw new Canceled();
      await sleep(Math.min(80, end - Date.now()));
    }
    if (this.t.cancel) throw new Canceled();
  }
}

let running = 0;
const queue: (() => void)[] = [];
async function slot() {
  if (running < prefs.concurrency) {
    running++;
    return;
  }
  await new Promise<void>((r) => queue.push(r));
  running++;
}
function release() {
  running--;
  queue.shift()?.();
}

function startTask(s: Srv, kind: string, fn: (c: Ctx) => Promise<void>, busyState?: string): string {
  if (s.taskId && tasks.get(s.taskId)?.state === "running") throw httpErr(409, "该服务器有任务正在执行，请稍候");
  const t: TaskView & { logs: LogLine[]; cancel: boolean } = {
    id: uid("t-"),
    serverId: s.id,
    kind,
    state: "running",
    step: "排队等待",
    done: 0,
    total: 0,
    error: "",
    logs: [] as LogLine[],
    cancel: false,
    startedAt: new Date().toISOString(),
  };
  tasks.set(t.id, t);
  s.taskId = t.id;
  const prevState = s.state;
  if (busyState) s.state = busyState;
  pushServer(s);
  emit({ type: "task", task: taskView(t) });
  const c = new Ctx(t, s);
  void (async () => {
    await slot();
    try {
      await fn(c);
      t.state = "done";
      t.step = "完成";
      c.log("ok", "任务完成");
    } catch (e) {
      if (e instanceof Canceled) {
        t.state = "canceled";
        t.step = "已取消";
        c.log("warn", "任务已取消");
        if (busyState) s.state = prevState === "connecting" ? "new" : prevState;
      } else {
        t.state = "failed";
        t.error = (e as Error).message;
        t.step = "失败";
        c.log("error", t.error);
        s.state = "error";
        s.error = t.error;
      }
    } finally {
      release();
      t.endedAt = new Date().toISOString();
      s.taskId = "";
      emit({ type: "task", task: taskView(t) });
      pushServer(s);
    }
  })();
  return t.id;
}

// ---------- 具体操作 ----------

async function doDetect(c: Ctx, trustNewKey: boolean) {
  const s = c.s;
  const h = s.host.toLowerCase();
  c.step("连接 SSH", 0, 4);
  c.log("info", `连接 ${s.user}@${s.host}:${s.port} …`);
  await c.sleep(500);
  if (!s.secret) throw new Error("缺少登录凭据：请编辑服务器重新输入密码，或解锁保险箱");
  if (h.includes("fail")) throw new Error("SSH 认证失败：用户名或密码错误");
  if (h.includes("key") && !s.trusted && !trustNewKey) {
    throw new Error("主机密钥不匹配（host key mismatch）：服务器指纹与上次记录不同，可能是重装系统或中间人攻击");
  }
  if (trustNewKey) {
    s.trusted = true;
    c.log("warn", "已信任新的主机密钥");
  }
  s.fingerprint = "SHA256:" + btoa(s.host + "mock-fingerprint").replace(/=/g, "").slice(0, 43);
  c.log("ok", `已连接，主机指纹 ${s.fingerprint}`);
  c.step("识别系统", 1);
  await c.sleep(450);
  const info = buildInfo(s.host);
  // 保留手动添加的地址
  const manual = (s.info?.addrs ?? []).filter((a) => a.source === "manual");
  info.addrs = [...(info.addrs ?? []), ...manual.filter((m) => !info.addrs!.some((a) => a.ip === m.ip))];
  if (s.manifest) {
    info.installed = true;
    info.version = "0.9.4";
  }
  c.log("info", `${info.os} · ${info.arch} · ${info.init} · ${info.pm}`);
  c.log("info", `防火墙：${info.firewalls?.join(", ") || "未启用"}；TCP 拥塞控制：${info.tcpCC}`);
  if (info.conflicts?.length) c.log("warn", `发现其它代理服务：${info.conflicts.join(", ")}`);
  c.step("枚举地址", 2);
  await c.sleep(350);
  const addrs = info.addrs ?? [];
  const v4 = addrs.filter((a) => a.family === 4).length;
  c.log("info", `网卡地址 ${addrs.filter((a) => a.source === "nic").length} 个，AnyIP ${addrs.filter((a) => a.source === "anyip").length} 个（IPv4 ${v4} / IPv6 ${addrs.length - v4}）`);
  if (info.anyIP?.length) c.log("info", `AnyIP 网段：${info.anyIP.join(", ")}`);
  c.step(`出口探测（${addrs.length} 个地址，48 路并发）`, 0, addrs.length);
  const batch = Math.max(8, Math.ceil(addrs.length / 12));
  for (let i = 0; i < addrs.length; i += batch) {
    await c.sleep(160);
    for (let j = i; j < Math.min(addrs.length, i + batch); j++) addrs[j] = probeAddr(addrs[j], s.host);
    c.progress(Math.min(addrs.length, i + batch));
  }
  const ok = addrs.filter((a) => a.probe === "ok");
  const nat = ok.filter((a) => a.public !== a.ip).length;
  c.log(ok.length === addrs.length ? "ok" : "warn", `出口探测完成：成功 ${ok.length} / ${addrs.length}${nat ? `，其中 NAT 映射 ${nat} 个` : ""}`);
  for (const f of addrs.filter((a) => a.probe === "fail").slice(0, 5)) c.log("warn", `${f.ip} 出口探测失败（超时）`);
  info.addrs = addrs;
  s.info = info;
  s.error = "";
  if (!s.selected?.length) s.selected = ok.map((a) => a.ip);
  else s.selected = s.selected.filter((ip) => addrs.some((a) => a.ip === ip));
  s.state = s.manifest ? "deployed" : "ready";
  if (s.manifest) {
    c.log("info", `读取已部署清单：${s.manifest.proxies?.length ?? 0} 个代理`);
  }
}

async function doProbe(c: Ctx, specs: string[], bind: boolean) {
  const s = c.s;
  if (!s.info) throw new Error("请先完成探测");
  let ips: string[] = [];
  for (const sp of specs) ips = ips.concat(expandSpec(sp));
  ips = [...new Set(ips)];
  c.step(`探测手动地址（${ips.length} 个）`, 0, ips.length);
  const addrs = s.info.addrs ?? [];
  const added: Addr[] = [];
  for (let i = 0; i < ips.length; i++) {
    const ip = ips[i];
    if (i % 16 === 0) {
      await c.sleep(120);
      c.progress(i);
    }
    if (addrs.some((a) => a.ip === ip)) continue;
    const a: Addr = {
      ip,
      prefix: ip.includes(":") ? 64 : 24,
      iface: s.info.defaultIface,
      family: ip.includes(":") ? 6 : 4,
      source: "manual",
      public: "",
      probe: "",
      needBind: bind,
    };
    added.push(probeAddr(a, s.host));
  }
  c.progress(ips.length);
  if (bind) c.log("info", `已将 ${added.length} 个地址绑定到 ${s.info.defaultIface}（持久化）`);
  s.info.addrs = [...addrs, ...added];
  const okN = added.filter((a) => a.probe === "ok").length;
  c.log(okN === added.length ? "ok" : "warn", `新增 ${added.length} 个地址，出口探测成功 ${okN} 个`);
  if (!bind && okN < added.length) c.log("warn", "未勾选「自动绑定」：不在网卡上的地址无法作为出口");
  s.selected = [...new Set([...(s.selected ?? []), ...added.filter((a) => a.probe === "ok").map((a) => a.ip)])];
}

function runTests(c: Ctx, proxies: Proxy[], where: string): TestResult[] {
  const res: TestResult[] = [];
  for (const p of proxies) {
    const r = rng(p.id + Date.now().toString().slice(0, -4));
    const localFail = p.family === 6 ? r() < 0.15 : r() < 0.04;
    if (where === "local" || where === "both" || where === "auto") {
      res.push({
        proxyId: p.id,
        where: "local",
        ok: !localFail,
        egress: localFail ? "" : p.public,
        expected: p.public,
        latencyMs: localFail ? 0 : Math.round(40 + r() * 260),
        authOK: localFail ? null : p.user ? true : false,
        error: localFail ? (p.family === 6 ? "本机无 IPv6 网络" : "连接超时") : undefined,
      });
    }
    if (where === "server" || where === "both" || (where === "auto" && localFail)) {
      res.push({
        proxyId: p.id,
        where: "server",
        ok: true,
        egress: p.public,
        expected: p.public,
        latencyMs: Math.round(3 + r() * 20),
        authOK: p.user ? true : false,
      });
    }
  }
  void c;
  return res;
}

async function doTest(c: Ctx, where: string) {
  const s = c.s;
  const proxies = s.manifest?.proxies ?? [];
  if (!proxies.length) throw new Error("没有已部署的代理");
  const label = where === "local" ? "本机实测" : where === "server" ? "服务器自测" : "本机 + 服务器测试";
  c.step(`${label}（${proxies.length} 个，32 路并发）`, 0, proxies.length);
  const chunk = Math.max(4, Math.ceil(proxies.length / 10));
  const all: TestResult[] = [];
  for (let i = 0; i < proxies.length; i += chunk) {
    await c.sleep(220);
    all.push(...runTests(c, proxies.slice(i, i + chunk), where));
    c.progress(Math.min(proxies.length, i + chunk));
  }
  // 合并：替换同 where 的旧结果
  const wheres = new Set(all.map((t) => t.where));
  s.tests = [...(s.tests ?? []).filter((t) => !wheres.has(t.where)), ...all];
  summarizeTests(c, all);
  pushServer(s);
}

function summarizeTests(c: Ctx, all: TestResult[]) {
  for (const w of ["local", "server"]) {
    const xs = all.filter((t) => t.where === w);
    if (!xs.length) continue;
    const ok = xs.filter((t) => t.ok).length;
    c.log(ok === xs.length ? "ok" : "warn", `${w === "local" ? "本机" : "服务器"}测试：通过 ${ok} / ${xs.length}`);
  }
  const lf = all.filter((t) => t.where === "local" && !t.ok).map((t) => t.proxyId);
  const sOk = new Set(all.filter((t) => t.where === "server" && t.ok).map((t) => t.proxyId));
  const sg = lf.filter((id) => sOk.has(id)).length;
  if (sg) c.log("warn", `${sg} 个代理服务器自测通过但本机失败：大概率是云厂商安全组未放行端口`);
}

function makeStats(s: Srv): Stat[] {
  const proxies = s.manifest?.proxies ?? [];
  const seen = new Map<number, Stat>();
  const r = rng(s.id + Math.floor(Date.now() / 5000));
  for (const p of proxies) {
    if (seen.has(p.slot) || !p.user) continue;
    const limit = p.limits.quotaGB * 1024;
    const used = r() < 0.3 ? 0 : r() * (limit || 30 * 1024) * (r() < 0.1 ? 1.05 : 0.6);
    seen.set(p.slot, { user: p.user, slot: p.slot, usedMB: Math.round(used * 10) / 10, limitMB: limit, period: p.limits.quotaPeriod || "M" });
  }
  return [...seen.values()];
}

function makeStatus(s: Srv, active = true) {
  const n = s.manifest?.proxies?.length ?? 0;
  const dns = s.manifest?.settings.dns.mode;
  s.status = {
    active,
    dnsActive: active && (dns === "recursive" || dns === "forward"),
    pid: active ? 1000 + Math.floor(Math.random() * 30000) : 0,
    threads: active ? n + 3 + Math.floor(Math.random() * 20) : 0,
    memMB: active ? Math.max(4, Math.round(3 + n * 0.08 + Math.random() * 6)) : 0,
    connections: active ? Math.floor(Math.random() * Math.max(5, n * 2)) : 0,
    since: active ? new Date(Date.now() - Math.random() * 86400000 * 3).toISOString() : "",
  };
}

async function doDeploy(c: Ctx, req: PlanRequest) {
  const s = c.s;
  if (!s.info) throw new Error("请先完成探测");
  const plan = req.edited?.length
    ? { proxies: req.edited, errors: [] as string[] }
    : makePlan(req.settings, req.selected, s.info.addrs ?? [], s.manifest, s.info.listening ?? [], s.id + "deploy" + Date.now());
  if (plan.errors?.length) throw new Error(plan.errors[0]);
  const proxies = plan.proxies ?? [];
  const info = s.info;
  const steps = 11;
  let n = 0;
  const st = (name: string) => c.step(name, n++, steps);

  st("连接 SSH");
  await c.sleep(400);
  c.log("ok", "已连接");
  st("上传脚本与配置");
  await c.sleep(350);
  c.log("info", "上传到临时目录 /tmp/aio.XXXXXX（结束后删除）");
  st("安装依赖");
  await c.sleep(700);
  c.log("info", `${info.pm} 安装 ca-certificates curl ${req.settings.dns.mode === "recursive" ? "unbound" : req.settings.dns.mode === "forward" ? "dnsmasq" : ""}`.trim());
  st("安装 3proxy");
  if (info.installed && info.version) {
    c.log("ok", `已安装 3proxy ${info.version}，复用`);
    await c.sleep(200);
  } else {
    if (info.osId === "alpine") {
      c.log("info", `下载源码 ${req.settings.githubMirror || ""}https://github.com/3proxy/3proxy/archive/refs/tags/0.9.4.tar.gz`);
      await c.sleep(600);
      c.log("info", "编译中（gcc / make，musl）…");
      await c.sleep(1400);
    } else {
      c.log("info", `下载官方 ${info.pm === "apt" ? "deb" : "rpm"} 包（${info.arch}）`);
      await c.sleep(900);
    }
    c.log("ok", "3proxy 0.9.4 安装完成");
    info.installed = true;
    info.version = "0.9.4";
  }
  if (req.settings.stopConflicts?.length) {
    c.log("warn", `停用冲突服务：${req.settings.stopConflicts.join(", ")}`);
    info.conflicts = (info.conflicts ?? []).filter((x) => !req.settings.stopConflicts!.includes(x));
  }
  st("绑定 IP");
  const binds = proxies.filter((p) => p.needBind);
  const bindIPs = new Set(binds.map((p) => p.listen));
  c.log("info", bindIPs.size ? `绑定 ${bindIPs.size} 个地址到网卡（开机自动恢复）` : "无需绑定额外地址");
  await c.sleep(300);
  st("写入配置");
  await c.sleep(400);
  c.log("info", `生成 ${proxies.length} 个监听，${new Set(proxies.map((p) => p.user)).size} 个账号`);
  const lim = req.settings.limits;
  if (lim.speedMbps || lim.maxConn || lim.quotaGB || lim.expiresAt) c.log("info", "已写入限速 / 连接数 / 流量额度 / 到期规则");
  st("配置 DNS");
  await c.sleep(300);
  const dnsDesc: Record<string, string> = {
    recursive: "本机递归（unbound）",
    forward: `本机缓存 + 转发（${req.settings.dns.servers?.join(", ")}）`,
    public: `公共 DNS 直连（${req.settings.dns.servers?.join(", ")}）`,
    system: "系统解析",
    custom: `自定义（${req.settings.dns.servers?.join(", ")}）`,
  };
  c.log("info", `DNS：${dnsDesc[req.settings.dns.mode] ?? req.settings.dns.mode}`);
  st("启动服务");
  await c.sleep(500);
  c.log("ok", `服务 aio-proxy 已启动（${info.init}，开机自启）`);
  st("防火墙放行");
  await c.sleep(300);
  if (req.settings.firewall && info.firewalls?.length) c.log("ok", `${info.firewalls.join(", ")} 已放行代理端口`);
  else c.log("info", "未启用防火墙或已关闭自动放行，跳过");
  c.log("warn", "云厂商安全组无法通过 SSH 修改，如有请在控制台放行端口");
  st("系统优化");
  await c.sleep(300);
  if (req.settings.bbr) c.log(info.tcpCC === "bbr" ? "info" : "ok", info.tcpCC === "bbr" ? "BBR 已启用" : "已开启 BBR");
  if (req.settings.tune) c.log("ok", "已调优内核参数（文件句柄、端口范围、连接队列）");

  // 清单写入
  const old = s.manifest;
  const m: Manifest = {
    version: 1,
    tool: "aio-proxy-tools",
    updatedAt: new Date().toISOString(),
    settings: clone(req.settings),
    proxies: clone(proxies),
    adminPort: 0,
    adminUser: "",
    adminPass: "",
    dnsEffective: req.settings.dns.mode === "recursive" ? "127.0.0.1 (unbound)" : (req.settings.dns.servers ?? []).join(", ") || "system",
  };
  s.manifest = m;
  void old;
  makeStatus(s);

  st(`服务器自检 + 本机实测（${proxies.length} 个）`);
  c.progress(0, proxies.length);
  const chunk = Math.max(4, Math.ceil(proxies.length / 10));
  const all: TestResult[] = [];
  for (let i = 0; i < proxies.length; i += chunk) {
    await c.sleep(200);
    all.push(...runTests(c, proxies.slice(i, i + chunk), "auto"));
    c.progress(Math.min(proxies.length, i + chunk));
  }
  s.tests = all;
  summarizeTests(c, all);
  s.stats = makeStats(s);
  s.state = "deployed";
  s.error = "";
  c.log("ok", `部署完成：${proxies.length} 个代理`);
}

// ---------- HTTP 路由 ----------

interface Resp {
  status: number;
  body: unknown;
}

function httpErr(status: number, msg: string) {
  return Object.assign(new Error(msg), { status });
}

function getSrv(id: string): Srv {
  const s = servers.get(id);
  if (!s) throw httpErr(404, "服务器不存在");
  return s;
}

function addServer(inp: ServerInput): Srv {
  const host = inp.host.trim();
  if (!host) throw httpErr(400, "主机地址不能为空");
  const s: Srv = {
    id: uid("s-"),
    name: inp.name?.trim() ?? "",
    host,
    port: inp.port || 22,
    user: inp.user || "root",
    authType: inp.authType || "password",
    hasSecret: false,
    remember: !!inp.remember && vault.unlocked,
    state: "new",
    error: "",
    info: null,
    selected: [],
    manifest: null,
    tests: [],
    stats: [],
    status: null,
    taskId: "",
    fingerprint: "",
    updatedAt: new Date().toISOString(),
    secret: !!(inp.password || inp.key),
    trusted: false,
    detectCount: 0,
  };
  servers.set(s.id, s);
  return s;
}

function parseText(text: string, d: { port: number; user: string; authType: string }): ParseResult {
  const out: ServerInput[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const parts = line.split(/[\s,]+/).filter(Boolean);
    const hp = parts[0];
    let port = d.port || 22;
    let host = hp;
    const m6 = hp.match(/^\[(.+)\](?::(\d+))?$/);
    if (m6) {
      host = m6[1];
      if (m6[2]) port = Number(m6[2]);
    } else if ((hp.match(/:/g) ?? []).length === 1) {
      const [h, p] = hp.split(":");
      host = h;
      port = Number(p);
    }
    if (!host || !(isValidIP(host) || /^[A-Za-z0-9.-]+$/.test(host))) {
      errors.push(`第 ${i + 1} 行：主机地址无效「${hp}」`);
      return;
    }
    if (!(port >= 1 && port <= 65535)) {
      errors.push(`第 ${i + 1} 行：端口无效`);
      return;
    }
    out.push({
      name: "",
      host,
      port,
      user: parts[1] || d.user || "root",
      authType: d.authType || "password",
      password: parts.slice(2).join(" "),
      key: "",
      passphrase: "",
      remember: false,
    });
    if (!parts[2]) errors.push(`第 ${i + 1} 行：未填写密码（添加后需单独填写）`);
  });
  return { servers: out, errors };
}

function seedDemo() {
  if ([...servers.values()].some((s) => s.name.startsWith("演示"))) return;
  const a = addServer({ name: "演示 · 包段机", host: "203.0.113.2", port: 22, user: "root", authType: "password", password: "x", key: "", passphrase: "", remember: false });
  const b = addServer({ name: "演示 · NAT 云主机", host: "198.51.100.7", port: 22, user: "admin", authType: "key", password: "", key: "x", passphrase: "", remember: false });
  const c = addServer({ name: "演示 · 多段机", host: "multi.example.net", port: 2222, user: "root", authType: "password", password: "x", key: "", passphrase: "", remember: false });
  const d = addServer({ name: "演示 · 密码错误", host: "fail.example.org", port: 22, user: "root", authType: "password", password: "x", key: "", passphrase: "", remember: false });
  // a：已部署
  a.info = buildInfo(a.host);
  a.info.addrs = (a.info.addrs ?? []).map((x) => probeAddr(x, a.host));
  a.info.installed = true;
  a.info.version = "0.9.4";
  a.fingerprint = "SHA256:" + btoa(a.host + "mock-fingerprint").replace(/=/g, "").slice(0, 43);
  const sel = (a.info.addrs ?? []).filter((x) => x.probe === "ok" && x.family === 4).slice(0, 64).map((x) => x.ip);
  a.selected = sel;
  const st: Settings = { ...defaultSettings(), limits: { speedMbps: 50, maxConn: 200, quotaGB: 500, quotaPeriod: "M", expiresAt: "2027-01-31" } };
  const plan = makePlan(st, sel, a.info.addrs ?? [], null, a.info.listening ?? [], "demo-a");
  a.manifest = { version: 1, tool: "aio-proxy-tools", updatedAt: new Date(Date.now() - 3600_000 * 26).toISOString(), settings: st, proxies: plan.proxies, adminPort: 0, adminUser: "", adminPass: "", dnsEffective: "127.0.0.1 (unbound)" };
  a.tests = runTests(null as unknown as Ctx, plan.proxies ?? [], "auto");
  a.stats = makeStats(a);
  makeStatus(a);
  a.state = "deployed";
  // b：已探测
  b.info = buildInfo(b.host);
  b.info.addrs = (b.info.addrs ?? []).map((x) => probeAddr(x, b.host));
  b.selected = (b.info.addrs ?? []).filter((x) => x.probe === "ok").map((x) => x.ip);
  b.state = "ready";
  // d：失败
  d.state = "error";
  d.error = "SSH 认证失败：用户名或密码错误";
  void c;
}

export async function mockFetch(method: string, path: string, body: unknown): Promise<Resp> {
  await sleep(60 + Math.random() * 120);
  try {
    return { status: 200, body: route(method, path.replace(/\?.*$/, ""), body as Record<string, never>) };
  } catch (e) {
    const err = e as Error & { status?: number };
    return { status: err.status ?? 500, body: { error: err.message } };
  }
}

function route(method: string, path: string, body: Record<string, unknown>): unknown {
  const seg = path.split("/").filter(Boolean).map(decodeURIComponent); // ["api", ...]
  const [, a, b, c] = seg;
  const M = method.toUpperCase();

  if (a === "meta" && M === "GET") {
    const meta: Meta = { version: "0.1.0-mock", vault: { exists: vault.exists, unlocked: vault.unlocked }, defaults: clone(prefs.defaults), prefs: clone(prefs) };
    return meta;
  }
  if (a === "prefs" && M === "PUT") {
    prefs = { ...prefs, ...(body as unknown as Preferences) };
    prefs.concurrency = Math.max(1, Math.min(10, prefs.concurrency || 3));
    return clone(prefs);
  }
  if (a === "__mock" && b === "seed") {
    seedDemo();
    for (const s of servers.values()) pushServer(s);
    return {};
  }
  if (a === "vault") {
    const pw = String(body?.password ?? "");
    if (b === "create") {
      if (vault.exists) throw httpErr(400, "保险箱已存在");
      if (pw.length < 6) throw httpErr(400, "主密码至少 6 位");
      Object.assign(vault, { exists: true, unlocked: true, password: pw });
    } else if (b === "unlock") {
      if (!vault.exists) throw httpErr(400, "保险箱不存在");
      if (pw !== vault.password) throw httpErr(403, "主密码错误");
      vault.unlocked = true;
      for (const s of servers.values()) if (s.remember) { s.secret = true; pushServer(s); }
    } else if (b === "lock") {
      vault.unlocked = false;
    } else if (b === "reset") {
      Object.assign(vault, { exists: false, unlocked: false, password: "" });
      for (const s of servers.values()) if (s.remember) { s.remember = false; pushServer(s); }
      return {};
    }
    return { exists: vault.exists, unlocked: vault.unlocked };
  }
  if (a === "tasks" && b) {
    const t = tasks.get(b);
    if (!t) throw httpErr(404, "任务不存在");
    if (c === "cancel" && M === "POST") {
      t.cancel = true;
      return {};
    }
    return taskView(t, true);
  }
  if (a === "batch" && M === "POST") {
    const action = String(body.action);
    const ids = (body.ids as string[]) ?? [];
    const taskIds: Record<string, string> = {};
    for (const id of ids) {
      const s = servers.get(id);
      if (!s) continue;
      try {
        if (action === "detect") taskIds[id] = startTask(s, "detect", (x) => doDetect(x, false), "connecting");
        else if (action === "test") taskIds[id] = startTask(s, "test", (x) => doTest(x, "both"));
        else if (action === "refresh") taskIds[id] = startTask(s, "refresh", (x) => doRefresh(x));
        else if (action === "deploy") {
          if (!s.info) continue;
          const sel = s.selected?.length ? s.selected : (s.info.addrs ?? []).filter((x) => x.probe === "ok").map((x) => x.ip);
          const settings = (body.settings as unknown as Settings) ?? prefs.defaults;
          taskIds[id] = startTask(s, "deploy", (x) => doDeploy(x, { settings, selected: sel, edited: null }), "deploying");
        }
      } catch {
        /* 跳过忙碌的服务器 */
      }
    }
    return { taskIds };
  }
  if (a !== "servers") throw httpErr(404, "接口不存在");

  if (!b) {
    if (M === "GET") return [...servers.values()].map(view);
    if (M === "POST") {
      const list = (body.servers as unknown as ServerInput[]) ?? [];
      const added = list.map(addServer);
      added.forEach(pushServer);
      return added.map(view);
    }
  }
  if (b === "parse" && M === "POST") {
    return parseText(String(body.text ?? ""), (body.defaults as unknown as { port: number; user: string; authType: string }) ?? { port: 22, user: "root", authType: "password" });
  }
  const s = getSrv(b);
  if (!c) {
    if (M === "DELETE") {
      if (s.taskId) tasks.get(s.taskId)!.cancel = true;
      servers.delete(s.id);
      emit({ type: "server-removed", id: s.id });
      return {};
    }
    if (M === "PATCH") {
      const inp = body as unknown as ServerInput;
      s.name = inp.name ?? s.name;
      s.host = inp.host || s.host;
      s.port = inp.port || s.port;
      s.user = inp.user || s.user;
      s.authType = inp.authType || s.authType;
      if (inp.password || inp.key) s.secret = true;
      s.remember = !!inp.remember && vault.unlocked;
      if (s.state === "error") s.state = s.info ? (s.manifest ? "deployed" : "ready") : "new";
      pushServer(s);
      return view(s);
    }
    if (M === "GET") return view(s);
  }
  switch (c) {
    case "selected": {
      s.selected = ((body.selected as string[]) ?? []).slice();
      pushServer(s);
      return view(s);
    }
    case "detect":
      return { taskId: startTask(s, "detect", (x) => doDetect(x, !!body?.trustNewKey), "connecting") };
    case "probe": {
      const addrs = (body.addrs as string[]) ?? [];
      for (const sp of addrs) {
        try {
          expandSpec(sp);
        } catch (e) {
          throw httpErr(400, (e as Error).message);
        }
      }
      return { taskId: startTask(s, "probe", (x) => doProbe(x, addrs, !!body.bind)) };
    }
    case "plan": {
      if (!s.info) throw httpErr(400, "请先完成探测");
      const req = body as unknown as PlanRequest;
      if (req.edited?.length) return { proxies: req.edited, warnings: [], errors: [], ports: [] };
      return makePlan(req.settings, req.selected ?? [], s.info.addrs ?? [], s.manifest, s.info.listening ?? [], s.id + "plan");
    }
    case "deploy": {
      if (!s.info) throw httpErr(400, "请先完成探测");
      const req = body as unknown as PlanRequest;
      if (!req.edited?.length) {
        const p = makePlan(req.settings, req.selected ?? [], s.info.addrs ?? [], s.manifest, s.info.listening ?? [], s.id + "chk");
        if (p.errors?.length) throw httpErr(400, p.errors[0]);
      }
      return { taskId: startTask(s, "deploy", (x) => doDeploy(x, req), "deploying") };
    }
    case "test":
      return { taskId: startTask(s, "test", (x) => doTest(x, String(body.where ?? "both"))) };
    case "refresh":
      return { taskId: startTask(s, "refresh", (x) => doRefresh(x)) };
    case "service": {
      const act = String(body.action);
      return {
        taskId: startTask(s, "service", async (x) => {
          if (!s.manifest) throw new Error("尚未部署");
          x.step(act === "start" ? "启动服务" : act === "stop" ? "停止服务" : "重启服务", 0, 1);
          await x.sleep(700);
          makeStatus(s, act !== "stop");
          x.progress(1);
          x.log("ok", act === "stop" ? "服务已停止" : "服务运行中");
        }),
      };
    }
    case "uninstall":
      return {
        taskId: startTask(s, "uninstall", async (x) => {
          const steps = ["停止服务", "撤销防火墙规则", "移除绑定的 IP", "删除文件"];
          for (let i = 0; i < steps.length; i++) {
            x.step(steps[i], i, steps.length);
            await x.sleep(450);
          }
          x.progress(steps.length);
          s.manifest = null;
          s.tests = [];
          s.stats = [];
          s.status = null;
          if (s.info) {
            s.info.installed = false;
            s.info.version = "";
          }
          s.state = s.info ? "ready" : "new";
          x.log("ok", "已卸载，服务器恢复原状");
        }),
      };
  }
  throw httpErr(404, "接口不存在");
}

async function doRefresh(c: Ctx) {
  const s = c.s;
  c.step("读取清单与状态", 0, 2);
  await c.sleep(500);
  if (!s.manifest) {
    c.log("info", "服务器上没有本工具部署的代理");
    c.progress(2);
    return;
  }
  c.progress(1);
  s.stats = makeStats(s);
  if (s.status) makeStatus(s, s.status.active);
  else makeStatus(s);
  c.log("ok", `清单 ${s.manifest.proxies?.length ?? 0} 个代理；服务${s.status?.active ? "运行中" : "已停止"}`);
  c.progress(2);
}

// 演示：?mock=demo 时自动载入示例服务器
if (new URLSearchParams(location.search).get("mock") === "demo") seedDemo();

