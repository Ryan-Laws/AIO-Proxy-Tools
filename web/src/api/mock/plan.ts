// mock 版的清单生成（真实逻辑在后端 internal/plan）
import type { Addr, Manifest, PlanResult, Proxy, PortRule, Settings } from "../types";
import { compareIP } from "@/lib/ip";
import { ECS_DNS } from "@/store/settings";
import { randStr, rng } from "./rand";

const NAME_RE = /^[A-Za-z0-9._-]+$/;

export function makePlan(
  settings: Settings,
  selected: string[],
  addrs: Addr[],
  manifest: Manifest | null,
  listening: string[],
  seed: string,
): PlanResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const sel = new Set(selected);
  const chosen = addrs.filter((a) => sel.has(a.ip)).sort((a, b) => compareIP(a.ip, b.ip));
  if (!chosen.length) {
    return { proxies: [], warnings: [], errors: ["未选择任何 IP：请在「IP 列表」中勾选要部署的地址"], ports: [] };
  }

  const protos: string[] =
    settings.protocol === "socks" ? ["socks"] : settings.protocol === "http" ? ["http"] : settings.protocol === "dual" ? ["socks", "http"] : ["auto"];

  const checkRule = (name: string, r: PortRule) => {
    if (r.mode === "random") {
      if (!(r.rangeMin >= 1 && r.rangeMax <= 65535 && r.rangeMin < r.rangeMax)) errors.push(`${name} 随机端口范围无效`);
      else if (r.rangeMax - r.rangeMin + 1 < chosen.length) errors.push(`${name} 随机端口范围不足以分配 ${chosen.length} 个端口`);
    } else {
      const max = r.mode === "inc" ? r.port + chosen.length - 1 : r.port;
      if (!(r.port >= 1 && max <= 65535)) errors.push(`${name} 端口超出范围（1-65535）${r.mode === "inc" ? `：递增到 ${max}` : ""}`);
    }
  };
  if (protos.includes("socks") || protos.includes("auto")) checkRule(settings.protocol === "auto" ? "代理" : "SOCKS5", settings.socks);
  if (protos.includes("http")) checkRule("HTTP", settings.http);

  if (
    settings.protocol === "dual" &&
    settings.socks.mode === "same" &&
    settings.http.mode === "same" &&
    settings.socks.port === settings.http.port
  ) {
    errors.push("SOCKS5 与 HTTP 使用了相同端口；如需同端口请选择「双协议·同端口」");
  }

  const a = settings.auth;
  if (a.mode === "custom") {
    if (!a.user || !a.pass) errors.push("自定义账号：用户名和密码不能为空");
    else if (!NAME_RE.test(a.user) || !NAME_RE.test(a.pass)) errors.push("自定义账号只能包含 A-Z a-z 0-9 . _ -");
  }
  if (a.mode === "list") {
    const list = a.list ?? [];
    if (list.length < chosen.length) errors.push(`账号表只有 ${list.length} 行，少于所选 IP 数 ${chosen.length}`);
    const bad = list.findIndex((c) => !NAME_RE.test(c.user) || !NAME_RE.test(c.pass));
    if (bad >= 0) errors.push(`账号表第 ${bad + 1} 行包含不允许的字符`);
  }
  if (a.mode === "per" || a.mode === "shared") {
    if (a.passLen < 8) warnings.push("密码长度小于 8，安全性较低");
    if (a.userPrefix && !NAME_RE.test(a.userPrefix)) errors.push("用户名前缀只能包含 A-Z a-z 0-9 . _ -");
  }
  if (a.mode === "none") {
    if (!settings.whitelist?.length) warnings.push("无认证且未设置来源 IP 白名单：代理将对整个互联网开放，极易被滥用");
    else warnings.push("无认证：仅白名单内的来源 IP 可使用");
  }
  if ((settings.dns.mode === "forward" || settings.dns.mode === "public" || settings.dns.mode === "custom") && settings.dns.servers?.some((s) => ECS_DNS.includes(s))) {
    warnings.push("DNS 列表包含会发送 ECS 的服务器（8.8.8.8 / 8.8.4.4 / 9.9.9.11），可能暴露服务器主网段");
  }
  if (settings.udp) warnings.push("SOCKS5 UDP 为实验性功能，部分云厂商会丢弃 UDP");
  const nat = chosen.filter((x) => x.public && x.public !== x.ip).length;
  if (nat) warnings.push(`${nat} 个地址经 NAT 映射，客户端需连接公网 IP，并需在云安全组放行端口`);
  const failed = chosen.filter((x) => x.probe === "fail").length;
  if (failed) warnings.push(`${failed} 个所选地址出口探测失败，部署后可能不可用`);
  const bind = chosen.filter((x) => x.needBind).length;
  if (bind) warnings.push(`${bind} 个地址不在网卡上，部署时将自动绑定（持久化）`);

  const old = new Map<string, Proxy>();
  if (settings.keepExisting && manifest?.proxies) for (const p of manifest.proxies) old.set(`${p.protocol}|${p.listen}`, p);

  const r = rng(seed);
  const shared = { user: (a.userPrefix || "") + randStr(r, a.userLen || 8, true), pass: randStr(r, a.passLen || 16) };
  const used = new Map<string, Set<number>>(); // proto -> ports（随机模式全局不重复）
  const busy = new Set(
    listening.map((l) => {
      const i = l.lastIndexOf(":");
      return `${l.slice(0, i).replace(/^\[|\]$/g, "")}|${l.slice(i + 1)}`;
    }),
  );

  const proxies: Proxy[] = [];
  chosen.forEach((addr, idx) => {
    let cred = { user: "", pass: "" };
    if (a.mode === "per") cred = { user: (a.userPrefix || "") + randStr(r, a.userLen || 8, true), pass: randStr(r, a.passLen || 16) };
    else if (a.mode === "shared") cred = shared;
    else if (a.mode === "custom") cred = { user: a.user, pass: a.pass };
    else if (a.mode === "list") cred = a.list?.[idx] ?? { user: "", pass: "" };
    for (const proto of protos) {
      const rule = proto === "http" ? settings.http : settings.socks;
      const prev = old.get(`${proto}|${addr.ip}`);
      let port: number;
      if (prev) port = prev.port;
      else if (rule.mode === "same") port = rule.port;
      else if (rule.mode === "inc") port = rule.port + idx;
      else {
        const set = used.get(proto) ?? new Set<number>();
        used.set(proto, set);
        const span = Math.max(1, rule.rangeMax - rule.rangeMin + 1);
        port = rule.rangeMin + Math.floor(r() * span);
        for (let k = 0; set.has(port) && k < span; k++) port = rule.rangeMin + ((port - rule.rangeMin + 1) % span);
        set.add(port);
      }
      if (busy.has(`${addr.ip}|${port}`) || busy.has(`0.0.0.0|${port}`) || (addr.family === 6 && busy.has(`::|${port}`))) {
        if (errors.length < 20) errors.push(`端口冲突：${addr.ip}:${port} 已被占用`);
      }
      const c = prev && settings.keepExisting ? { user: prev.user, pass: prev.pass } : cred;
      proxies.push({
        id: `${proto}-${addr.ip}`,
        listen: addr.ip,
        public: addr.public || addr.ip,
        family: addr.family,
        iface: addr.iface,
        prefix: addr.prefix,
        needBind: addr.needBind,
        protocol: proto,
        port,
        user: c.user,
        pass: c.pass,
        slot: a.mode === "shared" || a.mode === "custom" ? 1 : idx + 1,
        limits: { ...settings.limits },
        whitelist: settings.whitelist ?? [],
      });
    }
  });
  const kept = proxies.filter((p) => old.has(`${p.protocol}|${p.listen}`)).length;
  if (kept) warnings.push(`${kept} 个代理沿用原端口和账号`);

  return { proxies, warnings, errors, ports: portSummary(proxies, settings) };
}

export function portSummary(proxies: Proxy[], settings: Settings): string[] {
  const out: string[] = [];
  const byProto = new Map<string, number[]>();
  for (const p of proxies) {
    const arr = byProto.get(p.protocol) ?? [];
    arr.push(p.port);
    byProto.set(p.protocol, arr);
  }
  const label: Record<string, string> = { socks: "SOCKS5", http: "HTTP", auto: "自动识别" };
  for (const [proto, ports] of byProto) {
    const uniq = [...new Set(ports)].sort((a, b) => a - b);
    let desc: string;
    if (uniq.length === 1) desc = `tcp ${uniq[0]}`;
    else if (uniq[uniq.length - 1] - uniq[0] + 1 === uniq.length) desc = `tcp ${uniq[0]}-${uniq[uniq.length - 1]}`;
    else desc = `tcp ${uniq.length} 个端口（${uniq[0]}-${uniq[uniq.length - 1]}）`;
    out.push(`${label[proto] ?? proto}: ${desc}`);
    if (proto === "socks" && settings.udp) out.push(`SOCKS5 UDP: udp ${uniq.length === 1 ? uniq[0] : "同上"}`);
  }
  return out;
}
