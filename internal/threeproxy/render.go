// Package threeproxy 把代理清单渲染为 3proxy / unbound 配置及安装所需的附属文件，
// 并解析 3proxy 管理页的流量计数器。
package threeproxy

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"

	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/model"
	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/plan"
)

// Version 是部署的 3proxy 版本。官方发布提供 deb/rpm/源码及 SHA256 校验文件。
const Version = "1.0.1"

// DNSPort 是本机 unbound 监听端口（避开 53，避免与 systemd-resolved/dnsmasq 冲突）。
const DNSPort = 5335

// DefaultForwarders 是不发送 ECS（客户端子网）的公共解析器，用于转发模式与兜底。
var DefaultForwarders = []string{"1.1.1.1", "9.9.9.9", "1.0.0.1", "149.112.112.112"}

// ECSResolvers 会把客户端子网发给权威服务器，多段 IP 时会暴露主 IP 所在网段。
var ECSResolvers = map[string]bool{"8.8.8.8": true, "8.8.4.4": true, "9.9.9.11": true, "149.112.112.11": true,
	"2001:4860:4860::8888": true, "2001:4860:4860::8844": true}

var privateTargets = "0.0.0.0/8,10.0.0.0/8,100.64.0.0/10,127.0.0.0/8,169.254.0.0/16,172.16.0.0/12,192.168.0.0/16,224.0.0.0/4,::1/128,fc00::/7,fe80::/10"

// Options 是渲染时需要的服务器上下文。
type Options struct {
	ToolVersion string
	CPUs        int
	MemMB       int
	HasIPv6     bool
}

// Bundle 是一次部署上传到服务器的全部文件与环境变量。
type Bundle struct {
	Files map[string][]byte
	Env   map[string]string
}

// Render 生成部署包。m.AdminPort/AdminUser/AdminPass 必须已设置。
func Render(m *model.Manifest, o Options) (*Bundle, error) {
	s := m.Settings
	ps := m.Proxies
	if len(ps) == 0 {
		return nil, fmt.Errorf("代理清单为空")
	}
	var cfg strings.Builder
	w := func(f string, a ...any) { fmt.Fprintf(&cfg, f+"\n", a...) }

	w("# AIO Proxy Tools %s 自动生成，请勿手工修改（重新部署会覆盖）", o.ToolVersion)
	w("")
	w("# ---- DNS ----")
	w("# @dns")
	dnsServers := dnsServersFor(s.DNS)
	for _, ns := range dnsServers {
		w("nserver %s", ns)
	}
	if s.DNS.Mode != "system" {
		w("nscache 65536")
		w("nscache6 65536")
	}
	w("")
	w("# ---- 全局 ----")
	w("timeouts 1 5 30 60 180 1800 15 60")
	if s.Log {
		w("log /var/lib/aio-proxy/logs/3proxy.log D")
		w("rotate 7")
		w(`logformat "L%%Y-%%m-%%d %%H:%%M:%%S %%N %%U %%C:%%c %%n:%%r %%R via %%e in=%%I out=%%O err=%%E"`)
	}
	w("noforce")
	maxconn := s.MaxConn
	if maxconn <= 0 {
		maxconn = 2000
	}
	w("maxconn %d", maxconn)
	w("users $/etc/aio-proxy/users.active")
	w("")

	// 账号（去重，保持出现顺序）
	type acct struct {
		user, pass string
		slot       int
		limits     model.Limits
	}
	var accts []acct
	seenUser := map[string]bool{}
	for _, p := range ps {
		if p.User == "" || seenUser[p.User] {
			continue
		}
		seenUser[p.User] = true
		accts = append(accts, acct{p.User, p.Pass, p.Slot, p.Limits})
	}

	if len(accts) > 0 {
		w("# ---- 流量计数 / 额度（每个账号一条）----")
		w("counter /var/lib/aio-proxy/traffic.3cf")
		for _, a := range accts {
			period := a.limits.QuotaPeriod
			if period != "D" && period != "W" && period != "M" {
				period = "M"
			}
			limit := 999999999 // 只统计不限额
			if a.limits.QuotaGB > 0 {
				limit = int(math.Ceil(a.limits.QuotaGB * 1024))
			}
			w(`countall "%d/%s" %s %d %s`, a.slot, a.user, period, limit, a.user)
		}
		w("")
		var lim strings.Builder
		for _, a := range accts {
			if a.limits.SpeedMbps > 0 {
				bps := int64(a.limits.SpeedMbps * 1e6)
				fmt.Fprintf(&lim, "bandlimin %d %s\nbandlimout %d %s\n", bps, a.user, bps, a.user)
			}
			if a.limits.MaxConn > 0 {
				fmt.Fprintf(&lim, "connlim %d 0 %s\n", a.limits.MaxConn, a.user)
			}
		}
		if lim.Len() > 0 {
			w("# ---- 限速 / 并发限制 ----")
			cfg.WriteString(lim.String())
			w("")
		}
	}

	auth := "strong"
	if len(accts) == 0 {
		auth = "iponly"
	}
	w("auth %s", auth)
	w("")

	// 每个 IP 一组服务
	for _, p := range ps {
		w("# %s  %s:%d → 出口 %s", strings.ToUpper(p.Protocol), p.Public, p.Port, p.Listen)
		w("flush")
		if s.BlockPrivate {
			w("deny * * %s", privateTargets)
		} else {
			w("deny * * 127.0.0.0/8,::1/128") // 始终禁止经代理访问服务器本机服务
		}
		users := p.User
		if users == "" {
			users = "*"
		}
		src := "*"
		if len(p.Whitelist) > 0 {
			// 服务器自检时来源地址是监听地址本身
			src = strings.Join(append(append([]string(nil), p.Whitelist...), p.Listen), ",")
		}
		if p.Protocol != "http" {
			if s.UDP {
				w("allow %s %s * * UDPASSOC", users, src)
				w("parent 1000 intport 0.0.0.0 %s", strings.ReplaceAll(plan.UDPRange, ":", "-"))
			} else {
				w("deny * * * * UDPASSOC")
			}
		}
		w("allow %s %s", users, src)

		flags := fmt.Sprintf("-p%d -i%s -e%s", p.Port, p.Listen, p.Listen)
		if p.Family == 6 {
			flags = "-6 " + flags
		}
		natFlags := ""
		if p.Public != "" && p.Public != p.Listen && familyOf(p.Public) == p.Family {
			natFlags = fmt.Sprintf(" -Ne%s -Ni%s", p.Public, p.Public)
		}
		switch p.Protocol {
		case "socks":
			u2 := ""
			if p.User != "" {
				u2 = "-u2 "
			}
			w("socks %s%s%s", u2, flags, natFlags)
		case "http":
			w("proxy -a %s", flags)
		case "auto":
			w("auto -a %s%s", flags, natFlags)
		}
		w("")
	}

	// 注意：admin 的 -s（只读）模式在 3proxy 1.0.1 中不显示计数器，故不使用；
	// 接口只监听 127.0.0.1、需要密码，且代理用户被禁止访问回环地址。
	w("# ---- 流量统计接口（仅本机）----")
	w("flush")
	if auth != "strong" {
		w("auth strong")
	}
	w("allow %s", m.AdminUser)
	w("admin -p%d -i127.0.0.1", m.AdminPort)
	w("")
	w("end")

	// users.list：账号表（到期过滤后生成 users.active）
	var users strings.Builder
	fmt.Fprintf(&users, "%s:CL:%s\n", m.AdminUser, m.AdminPass)
	var expiry strings.Builder
	for _, a := range accts {
		fmt.Fprintf(&users, "%s:CL:%s\n", a.user, a.pass)
		if a.limits.ExpiresAt != "" {
			fmt.Fprintf(&expiry, "%s %s\n", a.user, a.limits.ExpiresAt)
		}
	}

	var listen, selftest, bind strings.Builder
	bound := map[string]bool{}
	for _, p := range ps {
		fmt.Fprintf(&listen, "%s %d\n", p.Listen, p.Port)
		u, pw := p.User, p.Pass
		if u == "" {
			u, pw = "-", "-"
		}
		proto := p.Protocol
		if proto == "auto" {
			proto = "socks"
		}
		fmt.Fprintf(&selftest, "%s %s %d %s %s %s %d\n", p.ID, p.Listen, p.Port, proto, u, pw, p.Family)
		if p.NeedBind && !bound[p.Listen] {
			bound[p.Listen] = true
			bits := 32
			if p.Family == 6 {
				bits = 128
			}
			fmt.Fprintf(&bind, "%s/%d %s\n", p.Listen, bits, p.Iface)
		}
	}
	fmt.Fprintf(&listen, "127.0.0.1 %d\n", m.AdminPort)

	var fw strings.Builder
	for _, line := range plan.PortSummary(ps, s.UDP) {
		fw.WriteString(line + "\n")
	}

	mj, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return nil, err
	}

	b := &Bundle{
		Files: map[string][]byte{
			"3proxy.cfg":   []byte(cfg.String()),
			"users.list":   []byte(users.String()),
			"expiry.list":  []byte(expiry.String()),
			"proxies.json": mj,
			"listen.txt":   []byte(listen.String()),
			"fw.txt":       []byte(fw.String()),
			"bind.txt":     []byte(bind.String()),
			"selftest.txt": []byte(selftest.String()),
		},
		Env: map[string]string{
			"TP_VERSION":     Version,
			"DNS_MODE":       s.DNS.Mode,
			"DNS_FALLBACK":   strings.Join(fallbackFor(s.DNS), " "),
			"FW":             b01(s.Firewall),
			"BBR":            b01(s.BBR),
			"TUNE":           b01(s.Tune),
			"SELFTEST":       "1",
			"MIRROR":         strings.TrimSpace(s.GitHubMirror),
			"TOOL_VERSION":   o.ToolVersion,
			"STOP_CONFLICTS": strings.Join(s.StopConflicts, " "),
		},
	}
	if s.DNS.Mode == "recursive" || s.DNS.Mode == "forward" {
		b.Files["unbound.conf"] = []byte(Unbound(s.DNS, o))
	}
	return b, nil
}

func b01(v bool) string {
	if v {
		return "1"
	}
	return "0"
}

func familyOf(ip string) int {
	if strings.Contains(ip, ":") {
		return 6
	}
	return 4
}

func dnsServersFor(d model.DNSRule) []string {
	switch d.Mode {
	case "recursive", "forward":
		return []string{fmt.Sprintf("127.0.0.1:%d", DNSPort)}
	case "public", "custom":
		var out []string
		for _, s := range serversOr(d.Servers, DefaultForwarders) {
			if strings.Count(s, ":") >= 2 && !strings.HasPrefix(s, "[") {
				s = "[" + s + "]"
			}
			out = append(out, s)
		}
		return out
	}
	return nil // system：使用系统解析
}

func fallbackFor(d model.DNSRule) []string {
	if d.Mode == "forward" || d.Mode == "public" || d.Mode == "custom" {
		var out []string
		for _, s := range d.Servers {
			// unbound forward-addr / 兜底仅支持纯 IP
			h := strings.Trim(strings.SplitN(s, "/", 2)[0], "[]")
			if i := strings.LastIndex(h, ":"); i > 0 && strings.Count(h, ":") == 1 {
				h = h[:i]
			}
			if h != "" {
				out = append(out, h)
			}
		}
		if len(out) > 0 {
			return out
		}
	}
	return DefaultForwarders
}

func serversOr(a, def []string) []string {
	var out []string
	for _, s := range a {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	if len(out) == 0 {
		return def
	}
	return out
}

// Unbound 生成本机解析器配置。
func Unbound(d model.DNSRule, o Options) string {
	threads := o.CPUs
	if threads < 1 {
		threads = 1
	}
	if threads > 4 {
		threads = 4
	}
	msg, rr := "16m", "32m"
	if o.MemMB >= 2000 {
		msg, rr = "64m", "128m"
	} else if o.MemMB >= 900 {
		msg, rr = "32m", "64m"
	}
	ip6 := "no"
	if o.HasIPv6 {
		ip6 = "yes"
	}
	var b strings.Builder
	fmt.Fprintf(&b, `# AIO Proxy Tools 自动生成：仅供本机 3proxy 使用的缓存解析器
server:
  interface: 127.0.0.1@%d
  port: %d
  access-control: 127.0.0.0/8 allow
  access-control: 0.0.0.0/0 refuse
  do-ip4: yes
  do-ip6: %s
  do-udp: yes
  do-tcp: yes
  num-threads: %d
  so-reuseport: yes
  msg-cache-size: %s
  rrset-cache-size: %s
  cache-min-ttl: 30
  prefetch: yes
  serve-expired: yes
  serve-expired-ttl: 86400
  qname-minimisation: yes
  hide-identity: yes
  hide-version: yes
  harden-glue: yes
  edns-buffer-size: 1232
  module-config: "iterator"
  chroot: ""
  username: ""
  directory: "/etc/unbound"
  pidfile: ""
  use-syslog: no
  logfile: ""
  verbosity: 0
`, DNSPort, DNSPort, ip6, threads, msg, rr)
	if d.Mode == "forward" {
		b.WriteString("\nforward-zone:\n  name: \".\"\n")
		for _, s := range fallbackFor(d) {
			fmt.Fprintf(&b, "  forward-addr: %s\n", s)
		}
	}
	return b.String()
}

// ---------- 流量计数器解析 ----------

var counterRow = regexp.MustCompile(`(?s)<tr><td>count(?:all|in|out)</td><td>(\d+)/([^<]*)</td>.*?<td>([0-9.]+)</td><td>([^<]*)</td><td>([0-9.]+)</td>`)

// ParseCounters 解析 3proxy 管理页 /C 的计数器表格。
func ParseCounters(html string) []model.Stat {
	var out []model.Stat
	for _, m := range counterRow.FindAllStringSubmatch(html, -1) {
		slot, _ := strconv.Atoi(m[1])
		limit, _ := strconv.ParseFloat(m[3], 64)
		used, _ := strconv.ParseFloat(m[5], 64)
		period := "M"
		switch {
		case strings.Contains(m[4], "day"):
			period = "D"
		case strings.Contains(m[4], "week"):
			period = "W"
		case strings.Contains(m[4], "hour"):
			period = "H"
		}
		if limit >= 999999999 {
			limit = 0
		}
		out = append(out, model.Stat{User: m[2], Slot: slot, UsedMB: used, LimitMB: limit, Period: period})
	}
	return out
}
