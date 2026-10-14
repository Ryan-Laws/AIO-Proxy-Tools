import * as React from "react";
import {
  AlertTriangleIcon,
  CableIcon,
  DicesIcon,
  GaugeIcon,
  GlobeIcon,
  InfoIcon,
  KeyRoundIcon,
  ListIcon,
  SettingsIcon,
  ShieldOffIcon,
  ShieldCheckIcon,
  UserIcon,
  UsersIcon,
  WaypointsIcon,
  FileTextIcon,
  ServerCogIcon,
} from "lucide-react";
import type { DNSMode, PortRule, Protocol, AuthMode, Settings, ServerInfo } from "@/api/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RadioGroup, RadioGroupItem, SegmentedRadio } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Callout, Field, NumberInput, SwitchRow } from "@/components/common";
import { ECS_DNS, NAME_RE } from "@/store/settings";
import { isValidCidrOrIP, isValidIP, splitList } from "@/lib/ip";
import { cn } from "@/lib/utils";
import { t, type MessageKey } from "@/i18n";

export interface FormErrors {
  [k: string]: string | undefined;
}

/** 客户端校验（后端 /plan 还会再校验一次） */
export function validateSettings(s: Settings, texts: { whitelist: string; list: string; dns: string }): FormErrors {
  const e: FormErrors = {};
  const checkRule = (key: string, r: PortRule) => {
    if (r.mode === "random") {
      if (!(r.rangeMin >= 1 && r.rangeMax <= 65535 && r.rangeMin < r.rangeMax)) e[key] = t("val.portRange");
    } else if (!(r.port >= 1 && r.port <= 65535)) e[key] = t("val.port");
  };
  if (s.protocol !== "http") checkRule("socks", s.socks);
  if (s.protocol === "http" || s.protocol === "dual") checkRule("http", s.http);
  if (s.auth.mode === "custom") {
    if (!s.auth.user || !NAME_RE.test(s.auth.user)) e.user = t("set.auth.charset");
    if (!s.auth.pass || !NAME_RE.test(s.auth.pass)) e.pass = t("set.auth.charset");
    else if (s.auth.pass.length < 6 || s.auth.pass.length > 64) e.pass = t("val.passLen");
  }
  if (s.auth.mode === "per" || s.auth.mode === "shared") {
    if (s.auth.userPrefix && !NAME_RE.test(s.auth.userPrefix)) e.prefix = t("set.auth.charset");
    if (!(s.auth.userLen >= 4 && s.auth.userLen <= 32)) e.userLen = "4-32";
    if (!(s.auth.passLen >= 8 && s.auth.passLen <= 64)) e.passLen = "8-64";
  }
  if (s.auth.mode === "list") {
    const bad = parseCredLines(texts.list).bad;
    if (bad.length) e.list = t("set.auth.listBad", { lines: bad.slice(0, 6).join("、") });
    else if (!s.auth.list?.length) e.list = t("val.listEmpty");
  }
  const wlBad = splitList(texts.whitelist).filter((x) => !isValidCidrOrIP(x));
  if (wlBad.length) e.whitelist = t("set.whitelistBad", { list: wlBad.slice(0, 4).join("、") });
  else if (s.auth.mode === "none" && !s.whitelist?.length) e.whitelist = t("val.noAuthWhitelist");
  if (s.dns.mode === "forward" || s.dns.mode === "public" || s.dns.mode === "custom") {
    const list = splitList(texts.dns);
    const bad = list.filter((x) => !isValidIP(x));
    if (!list.length) e.dns = t("val.dnsEmpty");
    else if (bad.length) e.dns = t("val.badFormat", { list: bad.slice(0, 4).join("、") });
  }
  if (s.githubMirror && !/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/\S*)?$/.test(s.githubMirror)) e.mirror = t("val.mirror");
  if (s.limits.expiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(s.limits.expiresAt)) e.expires = t("val.date");
  return e;
}

export function parseCredLines(text: string) {
  const list: { user: string; pass: string }[] = [];
  const bad: number[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const m = line.match(/^([^:\s]+)[:\s,]+(\S+)$/);
    if (!m || !NAME_RE.test(m[1]) || !NAME_RE.test(m[2]) || m[1].length > 64 || m[2].length < 6 || m[2].length > 64) bad.push(i + 1);
    else list.push({ user: m[1], pass: m[2] });
  });
  return { list, bad };
}

function randomToken(len: number) {
  const cs = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, (x) => cs[x % cs.length]).join("");
}

function Section({
  icon,
  title,
  desc,
  children,
  className,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  desc?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>
          <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary [&_svg]:size-3.5">{icon}</span>
          {title}
        </CardTitle>
        {desc && <CardDescription>{desc}</CardDescription>}
      </CardHeader>
      <CardContent className="grid gap-4">{children}</CardContent>
    </Card>
  );
}

function PortRuleEditor({
  id,
  title,
  rule,
  onChange,
  error,
}: {
  id: string;
  title: string;
  rule: PortRule;
  onChange: (r: PortRule) => void;
  error?: string;
}) {
  const up = (p: Partial<PortRule>) => onChange({ ...rule, ...p });
  return (
    <div className="grid gap-3 rounded-lg border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[13px] font-medium">{title}</span>
        <Tabs value={rule.mode} onValueChange={(v) => up({ mode: v as PortRule["mode"] })}>
          <TabsList className="h-8">
            <TabsTrigger value="same" className="px-2.5 text-xs">
              {t("set.port.same")}
            </TabsTrigger>
            <TabsTrigger value="inc" className="px-2.5 text-xs">
              {t("set.port.inc")}
            </TabsTrigger>
            <TabsTrigger value="random" className="px-2.5 text-xs">
              {t("set.port.random")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {rule.mode === "random" ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("set.port.min")} htmlFor={`${id}-min`}>
            <NumberInput id={`${id}-min`} value={rule.rangeMin} min={1} max={65535} onChange={(v) => up({ rangeMin: Math.round(v) })} />
          </Field>
          <Field label={t("set.port.max")} htmlFor={`${id}-max`}>
            <NumberInput id={`${id}-max`} value={rule.rangeMax} min={1} max={65535} onChange={(v) => up({ rangeMax: Math.round(v) })} />
          </Field>
        </div>
      ) : (
        <Field label={rule.mode === "inc" ? t("set.port.start") : t("set.port.port")} htmlFor={`${id}-port`} className="max-w-48">
          <NumberInput id={`${id}-port`} value={rule.port} min={1} max={65535} onChange={(v) => up({ port: Math.round(v) })} />
        </Field>
      )}
      <p className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>
        {error ?? t(`set.port.${rule.mode}D` as MessageKey)}
      </p>
    </div>
  );
}

export function SettingsForm({
  value: s,
  onChange,
  info,
  texts,
  setTexts,
  errors,
}: {
  value: Settings;
  onChange: (s: Settings) => void;
  info: ServerInfo | null;
  texts: { whitelist: string; list: string; dns: string };
  setTexts: (p: Partial<{ whitelist: string; list: string; dns: string }>) => void;
  errors: FormErrors;
}) {
  const up = (p: Partial<Settings>) => onChange({ ...s, ...p });
  const upAuth = (p: Partial<Settings["auth"]>) => up({ auth: { ...s.auth, ...p } });
  const upLim = (p: Partial<Settings["limits"]>) => up({ limits: { ...s.limits, ...p } });

  const ecs = splitList(texts.dns).filter((x) => ECS_DNS.includes(x));
  const dnsNeedsList = s.dns.mode === "forward" || s.dns.mode === "public" || s.dns.mode === "custom";
  const conflicts = info?.conflicts ?? [];
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="grid gap-4">
      {/* 协议 */}
      <Section icon={<WaypointsIcon />} title={t("set.protocol")}>
        <SegmentedRadio<Protocol>
          ariaLabel={t("set.protocol")}
          columns="grid-cols-2 2xl:grid-cols-4"
          value={s.protocol}
          onValueChange={(protocol) => up({ protocol })}
          options={(["socks", "http", "dual", "auto"] as Protocol[]).map((p) => ({
            value: p,
            label: t(`set.proto.${p}` as MessageKey),
            desc: t(`set.proto.${p}D` as MessageKey),
          }))}
        />
      </Section>

      {/* 端口 */}
      <Section icon={<CableIcon />} title={t("set.ports")}>
        <div className={cn("grid gap-3", s.protocol === "dual" && "xl:grid-cols-2")}>
          {s.protocol !== "http" && (
            <PortRuleEditor
              id="port-socks"
              title={s.protocol === "auto" ? t("set.port.auto") : t("set.port.socks")}
              rule={s.socks}
              onChange={(socks) => up({ socks })}
              error={errors.socks}
            />
          )}
          {(s.protocol === "http" || s.protocol === "dual") && (
            <PortRuleEditor id="port-http" title={t("set.port.http")} rule={s.http} onChange={(http) => up({ http })} error={errors.http} />
          )}
        </div>
      </Section>

      {/* 账号 */}
      <Section icon={<KeyRoundIcon />} title={t("set.auth")}>
        <SegmentedRadio<AuthMode>
          ariaLabel={t("set.auth")}
          columns="grid-cols-2 sm:grid-cols-3 2xl:grid-cols-5"
          value={s.auth.mode}
          onValueChange={(mode) => upAuth({ mode })}
          options={[
            { value: "per", icon: <UsersIcon />, label: t("set.auth.per"), desc: t("set.auth.perD") },
            { value: "shared", icon: <UserIcon />, label: t("set.auth.shared"), desc: t("set.auth.sharedD") },
            { value: "custom", icon: <KeyRoundIcon />, label: t("set.auth.custom"), desc: t("set.auth.customD") },
            { value: "list", icon: <ListIcon />, label: t("set.auth.list"), desc: t("set.auth.listD") },
            { value: "none", icon: <ShieldOffIcon />, label: t("set.auth.none"), desc: t("set.auth.noneD"), tone: "danger" },
          ]}
        />
        {(s.auth.mode === "per" || s.auth.mode === "shared") && (
          <div className="grid grid-cols-3 gap-3">
            <Field label={t("set.auth.prefix")} htmlFor="auth-prefix" error={errors.prefix}>
              <Input id="auth-prefix" value={s.auth.userPrefix} onChange={(e) => upAuth({ userPrefix: e.target.value.trim() })} spellCheck={false} />
            </Field>
            <Field label={t("set.auth.userLen")} htmlFor="auth-ulen" error={errors.userLen}>
              <NumberInput id="auth-ulen" value={s.auth.userLen} min={4} max={32} onChange={(v) => upAuth({ userLen: Math.round(v) })} />
            </Field>
            <Field label={t("set.auth.passLen")} htmlFor="auth-plen" error={errors.passLen}>
              <NumberInput id="auth-plen" value={s.auth.passLen} min={8} max={64} onChange={(v) => upAuth({ passLen: Math.round(v) })} />
            </Field>
            <p className="col-span-3 -mt-1 text-xs text-muted-foreground">
              {t("set.auth.example", {
                user: s.auth.userPrefix + "x".repeat(Math.max(0, Math.min(s.auth.userLen, 32))),
                pass: "•".repeat(Math.max(0, Math.min(s.auth.passLen, 64))),
              })}
            </p>
          </div>
        )}
        {s.auth.mode === "custom" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("set.auth.user")} htmlFor="auth-user" error={errors.user}>
              <Input id="auth-user" value={s.auth.user} onChange={(e) => upAuth({ user: e.target.value.trim() })} aria-invalid={!!errors.user || undefined} spellCheck={false} />
            </Field>
            <Field
              label={t("set.auth.pass")}
              htmlFor="auth-pass"
              error={errors.pass}
              right={
                <Button size="xs" variant="ghost" onClick={() => upAuth({ pass: randomToken(16) })}>
                  <DicesIcon />
                  {t("set.auth.gen")}
                </Button>
              }
            >
              <Input id="auth-pass" className="font-mono" value={s.auth.pass} onChange={(e) => upAuth({ pass: e.target.value.trim() })} aria-invalid={!!errors.pass || undefined} spellCheck={false} />
            </Field>
            {!errors.user && !errors.pass && <p className="text-xs text-muted-foreground sm:col-span-2">{t("set.auth.charset")}</p>}
          </div>
        )}
        {s.auth.mode === "list" && (
          <Field
            htmlFor="auth-list"
            error={errors.list}
            hint={`${t("set.auth.listCount", { n: s.auth.list?.length ?? 0 })} · ${t("set.auth.charset")}`}
          >
            <Textarea
              id="auth-list"
              rows={5}
              className="font-mono text-xs"
              placeholder={t("set.auth.listPh")}
              value={texts.list}
              aria-invalid={!!errors.list || undefined}
              onChange={(e) => {
                setTexts({ list: e.target.value });
                upAuth({ list: parseCredLines(e.target.value).list });
              }}
              spellCheck={false}
            />
          </Field>
        )}
        {s.auth.mode === "none" && (
          <Callout tone="danger" icon={<AlertTriangleIcon />}>
            {t("set.auth.noneWarn")}
          </Callout>
        )}
      </Section>

      {/* 白名单 */}
      <Section icon={<ShieldCheckIcon />} title={t("set.whitelist")} desc={t("set.whitelistD")}>
        <Field htmlFor="wl" error={errors.whitelist}>
          <Textarea
            id="wl"
            rows={3}
            className={cn("font-mono text-xs", s.auth.mode === "none" && !s.whitelist?.length && "border-destructive/60")}
            placeholder={t("set.whitelistPh")}
            value={texts.whitelist}
            aria-invalid={!!errors.whitelist || undefined}
            onChange={(e) => {
              setTexts({ whitelist: e.target.value });
              up({ whitelist: splitList(e.target.value).filter(isValidCidrOrIP) });
            }}
            spellCheck={false}
          />
        </Field>
      </Section>

      {/* 限制 */}
      <Section icon={<GaugeIcon />} title={t("set.limits")} desc={t("set.limitsD")}>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Field label={t("set.limit.speed")} htmlFor="lim-speed">
            <NumberInput id="lim-speed" value={s.limits.speedMbps} min={0} suffix={t("set.limit.speedU")} placeholder={t("common.unlimited")} onChange={(v) => upLim({ speedMbps: v })} />
          </Field>
          <Field label={t("set.limit.conn")} htmlFor="lim-conn">
            <NumberInput id="lim-conn" value={s.limits.maxConn} min={0} placeholder={t("common.unlimited")} onChange={(v) => upLim({ maxConn: Math.round(v) })} />
          </Field>
          <Field label={t("set.limit.quota")} htmlFor="lim-quota">
            <div className="flex gap-1.5">
              <NumberInput id="lim-quota" className="flex-1" value={s.limits.quotaGB} min={0} suffix={t("set.limit.quotaU")} placeholder={t("common.unlimited")} onChange={(v) => upLim({ quotaGB: v })} />
              <Select value={s.limits.quotaPeriod || "M"} onValueChange={(v) => upLim({ quotaPeriod: v })}>
                <SelectTrigger className="w-[76px]" aria-label={t("set.limit.period")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["D", "W", "M"] as const).map((p) => (
                    <SelectItem key={p} value={p}>
                      {t(`set.limit.period.${p}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </Field>
          <Field
            label={t("set.limit.expires")}
            htmlFor="lim-exp"
            error={errors.expires}
            right={
              s.limits.expiresAt ? (
                <button className="cursor-pointer text-xs text-muted-foreground hover:text-foreground" onClick={() => upLim({ expiresAt: "" })}>
                  {t("set.limit.clear")}
                </button>
              ) : null
            }
          >
            <Input id="lim-exp" type="date" min={today} value={s.limits.expiresAt} onChange={(e) => upLim({ expiresAt: e.target.value })} />
          </Field>
        </div>
        <Callout tone={s.auth.mode === "shared" || s.auth.mode === "custom" ? "warning" : "muted"} icon={<InfoIcon />}>
          {t("set.limitsNote")}
        </Callout>
      </Section>

      {/* DNS */}
      <Section icon={<GlobeIcon />} title={t("set.dns")}>
        <RadioGroup value={s.dns.mode} onValueChange={(v) => up({ dns: { ...s.dns, mode: v as DNSMode } })} className="gap-0 overflow-hidden rounded-lg border" aria-label={t("set.dns")}>
          {(["recursive", "forward", "public", "system", "custom"] as DNSMode[]).map((m) => (
            <label
              key={m}
              htmlFor={`dns-${m}`}
              className={cn(
                "flex cursor-pointer gap-3 border-b px-3 py-2.5 transition-colors last:border-b-0 hover:bg-muted/40",
                s.dns.mode === m && "bg-primary/[0.05]",
              )}
            >
              <RadioGroupItem id={`dns-${m}`} value={m} className="mt-0.5" />
              <div className="grid gap-0.5">
                <span className="flex items-center gap-2 text-[13px] font-medium">
                  {t(`set.dns.${m}` as MessageKey)}
                  {m === "recursive" && <span className="rounded bg-success/15 px-1.5 text-[10px] text-success">{t("common.recommended")}</span>}
                </span>
                <span className="text-xs leading-relaxed text-muted-foreground">{t(`set.dns.${m}D` as MessageKey)}</span>
              </div>
            </label>
          ))}
        </RadioGroup>
        {dnsNeedsList && (
          <Field label={t("set.dns.servers")} htmlFor="dns-servers" error={errors.dns}>
            <Input
              id="dns-servers"
              className="font-mono text-xs"
              placeholder={t("set.dns.serversPh")}
              value={texts.dns}
              aria-invalid={!!errors.dns || undefined}
              onChange={(e) => {
                setTexts({ dns: e.target.value });
                up({ dns: { ...s.dns, servers: splitList(e.target.value).filter(isValidIP) } });
              }}
              spellCheck={false}
            />
          </Field>
        )}
        {dnsNeedsList && ecs.length > 0 && (
          <Callout tone="warning" icon={<AlertTriangleIcon />}>
            {t("set.dns.ecsWarn", { list: ecs.join(" / ") })}
          </Callout>
        )}
        <Callout tone="muted" icon={<InfoIcon />}>
          {t("set.dns.hint")}
        </Callout>
      </Section>

      {/* 系统选项 */}
      <Section icon={<SettingsIcon />} title={t("set.sys")}>
        <div className="grid gap-x-8 lg:grid-cols-2">
          <div className="divide-y">
            <SwitchRow id="sw-fw" label={t("set.sys.firewall")} desc={t("set.sys.firewallD")} checked={s.firewall} onCheckedChange={(firewall) => up({ firewall })} />
            <SwitchRow id="sw-bbr" label={t("set.sys.bbr")} desc={t("set.sys.bbrD")} checked={s.bbr} onCheckedChange={(bbr) => up({ bbr })} />
            <SwitchRow id="sw-tune" label={t("set.sys.tune")} desc={t("set.sys.tuneD")} checked={s.tune} onCheckedChange={(tune) => up({ tune })} />
            <SwitchRow id="sw-bp" label={t("set.sys.blockPrivate")} desc={t("set.sys.blockPrivateD")} checked={s.blockPrivate} onCheckedChange={(blockPrivate) => up({ blockPrivate })} />
          </div>
          <div className="divide-y border-t lg:border-t-0">
            <SwitchRow
              id="sw-udp"
              label={t("set.sys.udp")}
              desc={t("set.sys.udpD")}
              checked={s.udp}
              onCheckedChange={(udp) => up({ udp })}
              disabled={s.protocol === "http"}
            />
            <SwitchRow id="sw-log" label={t("set.sys.log")} desc={t("set.sys.logD")} checked={s.log} onCheckedChange={(log) => up({ log })} />
            <SwitchRow id="sw-keep" label={t("set.sys.keep")} desc={t("set.sys.keepD")} checked={s.keepExisting} onCheckedChange={(keepExisting) => up({ keepExisting })} />
            <div className="flex items-start justify-between gap-4 py-2.5">
              <div className="grid gap-1">
                <Label htmlFor="sys-maxconn" className="text-[13px]">
                  {t("set.sys.maxConn")}
                </Label>
                <p className="text-xs text-muted-foreground">{t("set.sys.maxConnD")}</p>
              </div>
              <NumberInput id="sys-maxconn" className="w-24 shrink-0" value={s.maxConn} min={0} max={1000000} onChange={(v) => up({ maxConn: Math.round(v) })} />
            </div>
          </div>
        </div>
        <Separator />
        <div className="grid gap-4 lg:grid-cols-2">
          <Field label={<span className="flex items-center gap-1.5"><ServerCogIcon className="size-3.5" />{t("set.sys.stopConflicts")}</span>} hint={conflicts.length ? t("set.sys.stopConflictsD") : undefined}>
            {conflicts.length ? (
              <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-md border px-3 py-2">
                {conflicts.map((c) => {
                  const on = s.stopConflicts?.includes(c) ?? false;
                  return (
                    <label key={c} className="flex cursor-pointer items-center gap-2 text-[13px]">
                      <Checkbox
                        checked={on}
                        onCheckedChange={(v) =>
                          up({ stopConflicts: v === true ? [...(s.stopConflicts ?? []), c] : (s.stopConflicts ?? []).filter((x) => x !== c) })
                        }
                      />
                      <span className="font-mono text-xs">{c}</span>
                    </label>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{t("set.sys.noConflicts")}</p>
            )}
          </Field>
          <Field label={<span className="flex items-center gap-1.5"><FileTextIcon className="size-3.5" />{t("set.sys.mirror")}</span>} htmlFor="sys-mirror" hint={t("set.sys.mirrorD")} error={errors.mirror}>
            <Input
              id="sys-mirror"
              className="font-mono text-xs"
              placeholder={t("set.sys.mirrorPh")}
              value={s.githubMirror}
              onChange={(e) => up({ githubMirror: e.target.value.trim() })}
              spellCheck={false}
            />
          </Field>
        </div>
      </Section>
    </div>
  );
}
