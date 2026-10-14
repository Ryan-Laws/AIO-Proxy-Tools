// Package plan 根据设置与选中的 IP 生成代理清单（端口、账号分配与校验）。
package plan

import (
	"crypto/rand"
	"fmt"
	"math/big"
	"net"
	"net/netip"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/model"
	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/netx"
)

// Defaults 返回推荐的默认设置。
func Defaults() model.Settings {
	return model.Settings{
		Protocol:     "dual",
		Socks:        model.PortRule{Mode: "same", Port: 1080, RangeMin: 20000, RangeMax: 60000},
		HTTP:         model.PortRule{Mode: "same", Port: 8080, RangeMin: 20000, RangeMax: 60000},
		Auth:         model.AuthRule{Mode: "per", UserPrefix: "u", UserLen: 8, PassLen: 16},
		Limits:       model.Limits{QuotaPeriod: "M"},
		DNS:          model.DNSRule{Mode: "recursive", Servers: []string{"1.1.1.1", "9.9.9.9"}},
		KeepExisting: true,
		Firewall:     true,
		BBR:          true,
		Tune:         true,
		BlockPrivate: true,
		MaxConn:      2000,
	}
}

var credRe = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

// ValidCred 校验用户名/密码字符集（避免破坏 ip:port:user:pass 等导出格式和 3proxy 配置）。
func ValidCred(s string, min int) bool {
	return len(s) >= min && len(s) <= 64 && credRe.MatchString(s)
}

const (
	lower  = "abcdefghijklmnopqrstuvwxyz"
	digits = "0123456789"
	alnum  = lower + "ABCDEFGHIJKLMNOPQRSTUVWXYZ" + digits
)

func randString(chars string, n int) string {
	b := make([]byte, n)
	max := big.NewInt(int64(len(chars)))
	for i := range b {
		v, _ := rand.Int(rand.Reader, max)
		b[i] = chars[v.Int64()]
	}
	return string(b)
}

func randInt(min, max int) int {
	v, _ := rand.Int(rand.Reader, big.NewInt(int64(max-min+1)))
	return min + int(v.Int64())
}

// Input 是生成清单所需的全部上下文。
type Input struct {
	Settings  model.Settings
	Addrs     []model.Addr // 服务器上的全部地址（含探测结果）
	Selected  []string     // 选中的 IP
	Existing  *model.Manifest
	Listening []string // 服务器已占用的 "地址 端口"
	AdminPort int
}

// Build 生成清单。返回的 Result.Errors 非空时不可部署。
func Build(in Input) model.PlanResult {
	s := in.Settings
	var res model.PlanResult
	errf := func(f string, a ...any) { res.Errors = append(res.Errors, fmt.Sprintf(f, a...)) }
	warnf := func(f string, a ...any) { res.Warnings = append(res.Warnings, fmt.Sprintf(f, a...)) }

	byIP := map[string]model.Addr{}
	for _, a := range in.Addrs {
		byIP[a.IP] = a
	}
	var targets []model.Addr
	for _, ip := range in.Selected {
		a, ok := byIP[netx.Canon(ip)]
		if !ok {
			errf("IP %s 不在服务器地址列表中", ip)
			continue
		}
		targets = append(targets, a)
	}
	if len(targets) == 0 {
		errf("请至少选择一个 IP")
		return res
	}

	protos := protocolsOf(s.Protocol)
	if protos == nil {
		errf("未知协议 %q", s.Protocol)
		return res
	}

	// 现有部署：按 监听地址+协议 复用端口与账号
	type key struct{ ip, proto string }
	existing := map[key]model.Proxy{}
	maxSlot := 0
	if in.Existing != nil {
		maxSlot = in.Existing.MaxSlot
		for _, p := range in.Existing.Proxies {
			existing[key{p.Listen, p.Protocol}] = p
			if p.Slot > maxSlot {
				maxSlot = p.Slot
			}
		}
	}

	// 已占用端口（不含本工具自己的）
	ownPorts := map[string]bool{}
	if in.Existing != nil {
		for _, p := range in.Existing.Proxies {
			ownPorts[fmt.Sprintf("%s %d", p.Listen, p.Port)] = true
		}
		ownPorts[fmt.Sprintf("127.0.0.1 %d", in.Existing.AdminPort)] = true
	}
	busy := map[string]bool{}
	wild := map[int]bool{}
	for _, l := range in.Listening {
		if ownPorts[l] {
			continue
		}
		busy[l] = true
		h, p, _ := strings.Cut(l, " ")
		if h == "0.0.0.0" || h == "*" || h == "::" {
			var n int
			fmt.Sscan(p, &n)
			wild[n] = true
		}
	}
	used := map[string]bool{} // 本次已分配的 "ip port"
	portFree := func(ip string, port int) bool {
		k := fmt.Sprintf("%s %d", ip, port)
		return !busy[k] && !wild[port] && !used[k] && port != in.AdminPort
	}

	// 账号
	res.Errors = append(res.Errors, ValidateSettings(s)...)
	if len(res.Errors) > 0 {
		return res
	}
	var shared model.Cred
	switch s.Auth.Mode {
	case "shared":
		shared = model.Cred{User: genUser(s.Auth), Pass: randString(alnum, passLen(s.Auth))}
		// 沿用已部署的共享账号（之前也是共享模式时），保证所有 IP 仍是同一个账号
		if s.KeepExisting && in.Existing != nil && in.Existing.Settings.Auth.Mode == "shared" {
			for _, p := range in.Existing.Proxies {
				if p.User != "" {
					shared = model.Cred{User: p.User, Pass: p.Pass}
					break
				}
			}
		}
	case "custom":
		if !ValidCred(s.Auth.User, 1) {
			errf("自定义用户名只能包含字母、数字和 . _ -")
		}
		if !ValidCred(s.Auth.Pass, 6) {
			errf("自定义密码至少 6 位，只能包含字母、数字和 . _ -")
		}
		shared = model.Cred{User: s.Auth.User, Pass: s.Auth.Pass}
	case "list":
		if len(s.Auth.List) < len(targets) {
			errf("账号表只有 %d 组，少于选中的 %d 个 IP", len(s.Auth.List), len(targets))
		}
		for i, c := range s.Auth.List {
			if !ValidCred(c.User, 1) || !ValidCred(c.Pass, 6) {
				errf("账号表第 %d 行格式不正确（用户名/密码只能包含字母、数字和 . _ -，密码至少 6 位）", i+1)
				break
			}
		}
	case "none":
		if len(s.Whitelist) == 0 {
			errf("无认证时必须设置来源 IP 白名单，否则代理会对所有人开放，极易被滥用")
		}
	case "per":
	default:
		errf("未知认证方式 %q", s.Auth.Mode)
	}
	if len(res.Errors) > 0 {
		return res
	}

	userSlots := map[string]int{}
	if in.Existing != nil {
		for _, p := range in.Existing.Proxies {
			if p.User != "" {
				userSlots[p.User] = p.Slot
			}
		}
	}
	slotFor := func(user string) int {
		if user == "" {
			return 0
		}
		if v, ok := userSlots[user]; ok {
			return v
		}
		maxSlot++
		userSlots[user] = maxSlot
		return maxSlot
	}

	usersSeen := map[string]string{}
	for i, a := range targets {
		var cred model.Cred
		switch s.Auth.Mode {
		case "shared", "custom":
			cred = shared
		case "list":
			cred = s.Auth.List[i]
		case "per":
			for {
				cred = model.Cred{User: genUser(s.Auth), Pass: randString(alnum, passLen(s.Auth))}
				if _, dup := usersSeen[cred.User]; !dup {
					break
				}
			}
		}
		// 同一 IP 的多个协议共用一组账号；沿用已部署的账号（共享模式已在上面统一处理）
		if s.KeepExisting && s.Auth.Mode == "per" {
			for _, proto := range protos {
				if old, ok := existing[key{a.IP, proto}]; ok && old.User != "" {
					cred = model.Cred{User: old.User, Pass: old.Pass}
					break
				}
			}
		}
		if prev, dup := usersSeen[cred.User]; dup && s.Auth.Mode == "list" && prev != cred.Pass {
			res.Errors = append(res.Errors, fmt.Sprintf("账号表中用户名 %s 重复且密码不同", cred.User))
			return res
		}
		usersSeen[cred.User] = cred.Pass

		public := a.Public
		if public == "" {
			public = a.IP
			if netx.IsPrivate(a.IP) {
				warnf("%s 是内网地址且未测出公网出口，客户端可能无法连接", a.IP)
			}
		}
		for _, proto := range protos {
			rule := s.Socks
			if proto == "http" {
				rule = s.HTTP
			}
			port := 0
			if old, ok := existing[key{a.IP, proto}]; ok && s.KeepExisting && rule.Mode != "same" {
				port = old.Port
			}
			if port == 0 {
				switch rule.Mode {
				case "same":
					port = rule.Port
				case "inc":
					port = rule.Port + i
				case "random":
					lo, hi := rule.RangeMin, rule.RangeMax
					if lo == 0 && hi == 0 {
						lo, hi = 20000, 60000
					}
					for try := 0; try < 200; try++ {
						port = randInt(lo, hi)
						if portFree(a.IP, port) {
							break
						}
					}
				default:
					res.Errors = append(res.Errors, fmt.Sprintf("未知端口模式 %q", rule.Mode))
					return res
				}
			}
			if port < 1 || port > 65535 {
				res.Errors = append(res.Errors, fmt.Sprintf("%s 的端口 %d 超出范围", a.IP, port))
				continue
			}
			if !portFree(a.IP, port) {
				res.Errors = append(res.Errors, fmt.Sprintf("%s:%d 已被占用", a.IP, port))
				continue
			}
			used[fmt.Sprintf("%s %d", a.IP, port)] = true
			p := model.Proxy{
				ID:        proxyID(a.IP, proto),
				Listen:    a.IP,
				Public:    public,
				Family:    a.Family,
				Iface:     a.Iface,
				Prefix:    a.Prefix,
				NeedBind:  a.NeedBind,
				Protocol:  proto,
				Port:      port,
				User:      cred.User,
				Pass:      cred.Pass,
				Slot:      slotFor(cred.User),
				Limits:    s.Limits,
				Whitelist: append([]string(nil), s.Whitelist...),
			}
			if old, ok := existing[key{a.IP, proto}]; ok && s.KeepExisting && old.User == cred.User {
				p.Limits = mergeLimits(s.Limits, old.Limits)
			}
			res.Proxies = append(res.Proxies, p)
		}
	}
	// NAT：多个内网地址映射到同一公网地址时，相同端口的代理在客户端看来是同一个
	pub := map[string][]string{}
	for _, p := range res.Proxies {
		if p.Public != "" && p.Public != p.Listen {
			h := p.Public
			if strings.Contains(h, ":") {
				h = "[" + h + "]"
			}
			k := fmt.Sprintf("%s:%d", h, p.Port)
			pub[k] = append(pub[k], p.Listen)
		}
	}
	pubKeys := make([]string, 0, len(pub))
	for k := range pub {
		pubKeys = append(pubKeys, k)
	}
	sort.Strings(pubKeys)
	for _, k := range pubKeys {
		if l := pub[k]; len(l) > 1 {
			warnf("%s 由 %d 个内网地址（%s）共用：它们映射到同一个公网 IP，客户端无法区分，出口也相同", k, len(l), strings.Join(l, "、"))
		}
	}
	if len(res.Proxies) > 0 && s.Auth.Mode != "per" && s.Auth.Mode != "list" && hasLimits(s.Limits) && len(targets) > 1 {
		warnf("限速、限连接和流量额度按账号生效：当前所有 IP 共用一个账号，限制会被所有 IP 共享。需要每个 IP 单独限制，请选择“每 IP 独立随机”")
	}
	res.Ports = PortSummary(res.Proxies, s.UDP)
	for _, e := range Validate(res.Proxies, in) {
		res.Errors = append(res.Errors, e)
	}
	return res
}

// Validate 校验（可能被用户手动编辑过的）清单。
func Validate(ps []model.Proxy, in Input) []string {
	var errs []string
	seen := map[string]bool{}
	cred := map[string]string{}
	byIP := map[string]bool{}
	for _, a := range in.Addrs {
		byIP[a.IP] = true
	}
	for _, p := range ps {
		k := fmt.Sprintf("%s %d", p.Listen, p.Port)
		if seen[k] {
			errs = append(errs, fmt.Sprintf("%s:%d 重复", p.Listen, p.Port))
		}
		seen[k] = true
		if !byIP[p.Listen] {
			errs = append(errs, fmt.Sprintf("%s 不是该服务器的地址", p.Listen))
		}
		if p.Port < 1 || p.Port > 65535 {
			errs = append(errs, fmt.Sprintf("%s 端口 %d 无效", p.Listen, p.Port))
		}
		if p.Port == in.AdminPort && in.AdminPort != 0 {
			errs = append(errs, fmt.Sprintf("端口 %d 保留给统计接口", p.Port))
		}
		// 以下字段会写入服务器上的 3proxy 配置与脚本，必须严格校验（防止注入）
		if !isIP(p.Listen) {
			errs = append(errs, fmt.Sprintf("监听地址 %q 无效", p.Listen))
		}
		if p.Public != "" && !isIP(p.Public) {
			errs = append(errs, fmt.Sprintf("%s 的公网地址 %q 无效", p.Listen, p.Public))
		}
		if p.Iface != "" && !ifaceRe.MatchString(p.Iface) {
			errs = append(errs, fmt.Sprintf("%s 的网卡名 %q 无效", p.Listen, p.Iface))
		}
		if p.Prefix < 0 || p.Prefix > 128 {
			errs = append(errs, fmt.Sprintf("%s 的前缀长度 %d 无效", p.Listen, p.Prefix))
		}
		if p.ID != "" && !idRe.MatchString(p.ID) {
			errs = append(errs, fmt.Sprintf("代理 ID %q 无效", p.ID))
		}
		for _, w := range p.Whitelist {
			if !isIPOrPrefix(w) {
				errs = append(errs, fmt.Sprintf("%s 的白名单条目 %q 无效", p.Listen, w))
			}
		}
		errs = append(errs, validateLimits(p.Limits, fmt.Sprintf("%s:%d ", p.Listen, p.Port))...)
		if p.User != "" || p.Pass != "" {
			if !ValidCred(p.User, 1) || !ValidCred(p.Pass, 6) {
				errs = append(errs, fmt.Sprintf("%s:%d 的账号不合法（字母、数字和 . _ -，密码至少 6 位）", p.Listen, p.Port))
			}
			if old, ok := cred[p.User]; ok && old != p.Pass {
				errs = append(errs, fmt.Sprintf("用户名 %s 出现多次但密码不同", p.User))
			}
			cred[p.User] = p.Pass
		}
		switch p.Protocol {
		case "socks", "http", "auto":
		default:
			errs = append(errs, fmt.Sprintf("未知协议 %q", p.Protocol))
		}
	}
	return errs
}

var (
	ifaceRe   = regexp.MustCompile(`^[A-Za-z0-9_.:@-]{1,15}$`)
	idRe      = regexp.MustCompile(`^[a-z]+-[0-9A-Za-z_]+$`)
	dateRe    = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	unitRe    = regexp.MustCompile(`^[A-Za-z0-9@._-]{1,64}$`)
	mirrorRe  = regexp.MustCompile(`^https://[A-Za-z0-9.-]+(:\d{1,5})?(/[A-Za-z0-9._~%+=/-]*)?$`)
	dnsPortRe = regexp.MustCompile(`^\d{1,5}$`)
)

func isIP(s string) bool {
	a, err := netip.ParseAddr(s)
	return err == nil && a.Zone() == ""
}

func isIPOrPrefix(s string) bool {
	if isIP(s) {
		return true
	}
	_, err := netip.ParsePrefix(s)
	return err == nil
}

// validDNSServer 接受 IP、IP:端口、[IPv6]:端口
func validDNSServer(s string) bool {
	if isIP(s) {
		return true
	}
	h, p, err := net.SplitHostPort(s)
	return err == nil && isIP(h) && dnsPortRe.MatchString(p)
}

func validateLimits(l model.Limits, prefix string) []string {
	var errs []string
	if l.SpeedMbps < 0 || l.MaxConn < 0 || l.QuotaGB < 0 {
		errs = append(errs, prefix+"限速、并发和流量额度不能为负数")
	}
	switch l.QuotaPeriod {
	case "", "D", "W", "M":
	default:
		errs = append(errs, fmt.Sprintf("%s流量周期 %q 无效（D/W/M）", prefix, l.QuotaPeriod))
	}
	if l.ExpiresAt != "" {
		if _, err := time.Parse("2006-01-02", l.ExpiresAt); err != nil || !dateRe.MatchString(l.ExpiresAt) {
			errs = append(errs, fmt.Sprintf("%s到期日期 %q 格式应为 YYYY-MM-DD", prefix, l.ExpiresAt))
		}
	}
	return errs
}

// ValidateSettings 校验会写进服务器配置的设置项。预览、部署（含手动编辑过的清单）都会调用。
func ValidateSettings(s model.Settings) []string {
	var errs []string
	for _, w := range s.Whitelist {
		if !isIPOrPrefix(w) {
			errs = append(errs, fmt.Sprintf("白名单条目无效: %s", w))
		}
	}
	switch s.DNS.Mode {
	case "recursive", "system", "":
	case "forward", "public", "custom":
		for _, d := range s.DNS.Servers {
			if !validDNSServer(d) {
				errs = append(errs, fmt.Sprintf("DNS 服务器 %q 无效（应为 IP 或 IP:端口）", d))
			}
		}
	default:
		errs = append(errs, fmt.Sprintf("未知 DNS 模式 %q", s.DNS.Mode))
	}
	for _, r := range []struct {
		name string
		rule model.PortRule
	}{{"SOCKS5", s.Socks}, {"HTTP", s.HTTP}} {
		if r.rule.Mode == "random" && !(r.rule.RangeMin == 0 && r.rule.RangeMax == 0) {
			if r.rule.RangeMin < 1 || r.rule.RangeMax > 65535 || r.rule.RangeMin >= r.rule.RangeMax {
				errs = append(errs, fmt.Sprintf("%s 随机端口范围 %d-%d 无效", r.name, r.rule.RangeMin, r.rule.RangeMax))
			}
		}
	}
	if s.Auth.PassLen != 0 && (s.Auth.PassLen < 8 || s.Auth.PassLen > 64) {
		errs = append(errs, fmt.Sprintf("随机密码长度 %d 无效（8-64）", s.Auth.PassLen))
	}
	if s.Auth.UserLen != 0 && (s.Auth.UserLen < 4 || s.Auth.UserLen > 32) {
		errs = append(errs, fmt.Sprintf("随机用户名长度 %d 无效（4-32）", s.Auth.UserLen))
	}
	if s.Auth.UserPrefix != "" && (!ValidCred(s.Auth.UserPrefix, 1) || len(s.Auth.UserPrefix) > 16) {
		errs = append(errs, "用户名前缀只能包含字母、数字和 . _ -，最多 16 位")
	}
	if s.MaxConn < 0 {
		errs = append(errs, "每服务最大并发不能为负数")
	}
	errs = append(errs, validateLimits(s.Limits, "")...)
	for _, u := range s.StopConflicts {
		if !unitRe.MatchString(u) {
			errs = append(errs, fmt.Sprintf("服务名 %q 无效", u))
		}
	}
	if s.GitHubMirror != "" && !mirrorRe.MatchString(s.GitHubMirror) {
		errs = append(errs, "GitHub 镜像必须是 https:// 开头的地址")
	}
	return errs
}

func mergeLimits(def, old model.Limits) model.Limits {
	// 设置里显式给出的限制优先，否则保留原有限制
	if def.SpeedMbps == 0 {
		def.SpeedMbps = old.SpeedMbps
	}
	if def.MaxConn == 0 {
		def.MaxConn = old.MaxConn
	}
	if def.QuotaGB == 0 {
		def.QuotaGB = old.QuotaGB
		def.QuotaPeriod = old.QuotaPeriod
	}
	if def.ExpiresAt == "" {
		def.ExpiresAt = old.ExpiresAt
	}
	return def
}

func hasLimits(l model.Limits) bool {
	return l.SpeedMbps > 0 || l.MaxConn > 0 || l.QuotaGB > 0
}

func protocolsOf(p string) []string {
	switch p {
	case "socks":
		return []string{"socks"}
	case "http":
		return []string{"http"}
	case "dual":
		return []string{"socks", "http"}
	case "auto":
		return []string{"auto"}
	}
	return nil
}

func proxyID(ip, proto string) string {
	return proto + "-" + strings.NewReplacer(":", "_", ".", "_").Replace(ip)
}

func genUser(a model.AuthRule) string {
	n := a.UserLen
	if n < 4 || n > 32 {
		n = 8
	}
	prefix := a.UserPrefix
	if !ValidCred(prefix, 1) {
		prefix = ""
	}
	if prefix == "" {
		return string(lower[randInt(0, 25)]) + randString(lower+digits, n-1)
	}
	return prefix + randString(lower+digits, n)
}

func passLen(a model.AuthRule) int {
	if a.PassLen < 8 || a.PassLen > 64 {
		return 16
	}
	return a.PassLen
}

// UDPRange 是 SOCKS5 UDP 转发使用的端口范围（每个 IP 独立）。
const UDPRange = "40000:40999"

// PortSummary 生成端口占用摘要（同时用于防火墙规则），如 ["tcp 1080", "tcp 20000:20255"]。
func PortSummary(ps []model.Proxy, udp bool) []string {
	var tcp []int
	needUDP := false
	for _, p := range ps {
		tcp = append(tcp, p.Port)
		if p.Protocol != "http" {
			needUDP = true
		}
	}
	var out []string
	for _, r := range netx.PortRanges(tcp) {
		out = append(out, "tcp "+r)
	}
	sort.Strings(out)
	if udp && needUDP {
		out = append(out, "udp "+UDPRange)
	}
	return out
}
