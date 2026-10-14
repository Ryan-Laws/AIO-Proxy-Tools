package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/detect"
	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/model"
	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/netx"
	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/plan"
	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/sshx"
	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/task"
	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/tester"
	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/threeproxy"
	"github.com/Ryan-Laws/AIO-Proxy-Tools/scripts"
)

// script 执行一个内嵌脚本，日志写入任务，返回完整输出与退出码。
func script(ctx context.Context, c *sshx.Client, t *task.Task, body string, files map[string][]byte, env map[string]string, quiet bool) (string, int, error) {
	var out strings.Builder
	var mu sync.Mutex
	code, err := c.RunScript(ctx, sshx.Script{Body: body, Files: files, Env: env, OnLine: func(line string) {
		mu.Lock()
		out.WriteString(line + "\n")
		mu.Unlock()
		if quiet || strings.HasPrefix(line, "::test::") || strings.HasPrefix(line, "::need::") || strings.HasPrefix(line, "::dns::") ||
			strings.HasPrefix(line, "::counters::") || strings.HasPrefix(line, "::manifest::") {
			return
		}
		if strings.TrimSpace(line) != "" {
			t.Log("", line)
		}
	}})
	return out.String(), code, err
}

func (a *App) setError(s *Server, err error) {
	a.update(s, func(v *model.ServerView) {
		v.State = "error"
		v.Error = err.Error()
	})
}

// ---------- 探测 ----------

func (a *App) Detect(id string, trustNew, batch bool) (string, error) {
	return a.run(id, "detect", batch, func(ctx context.Context, t *task.Task, s *Server) error {
		err := a.detect(ctx, t, s, trustNew)
		if err != nil {
			a.setError(s, err)
		}
		return err
	})
}

func (a *App) detect(ctx context.Context, t *task.Task, s *Server, trustNew bool) error {
	a.update(s, func(v *model.ServerView) { v.State = "connecting"; v.Error = "" })
	t.Progress(0, 3)
	t.Step("连接 " + s.view.Host)
	c, err := a.client(ctx, s, trustNew)
	if err != nil {
		return err
	}
	t.OK("已连接，主机密钥指纹 " + c.Fingerprint)
	if !c.IsRoot() {
		t.Info("当前用户不是 root，将通过 sudo 执行")
	}

	t.Step("识别系统、防火墙和 IP 地址")
	out, code, err := script(ctx, c, t, scripts.Detect, nil, nil, true)
	if err != nil {
		return err
	}
	if code != 0 && !strings.Contains(out, "DETECT_DONE=1") {
		return fmt.Errorf("探测脚本失败（退出码 %d）", code)
	}
	info, err := detect.Parse(out)
	if err != nil {
		return err
	}
	t.OK(fmt.Sprintf("%s · %s · %s · 发现 %d 个地址", info.OS, info.Arch, info.Init, len(info.Addrs)))
	if len(info.Firewalls) > 0 {
		t.Info("防火墙: " + strings.Join(info.Firewalls, ", "))
	}
	for _, w := range info.Warnings {
		t.Warn(w)
	}
	if len(info.Conflicts) > 0 {
		t.Warn("检测到其它代理服务正在运行: " + strings.Join(info.Conflicts, ", "))
	}
	t.Progress(1, 3)

	// 保留之前手动添加的地址
	s.mu.Lock()
	if s.view.Info != nil {
		have := map[string]bool{}
		for _, ad := range info.Addrs {
			have[ad.IP] = true
		}
		for _, ad := range s.view.Info.Addrs {
			if ad.Source == "manual" && !have[ad.IP] {
				info.Addrs = append(info.Addrs, ad)
			}
		}
		detect.SortAddrs(info.Addrs)
	}
	s.mu.Unlock()

	if err := a.probe(ctx, t, c, info.Addrs); err != nil {
		t.Warn("出口探测失败: " + err.Error())
	}
	t.Progress(2, 3)

	var manifest *model.Manifest
	if info.Installed {
		t.Step("读取已部署的代理")
		manifest, _ = a.readManifest(ctx, c, t)
		if manifest != nil {
			t.OK(fmt.Sprintf("服务器上已有 %d 个代理", len(manifest.Proxies)))
		}
	}
	a.update(s, func(v *model.ServerView) {
		v.Info = info
		v.Manifest = manifest
		v.State = "ready"
		if manifest != nil {
			v.State = "deployed"
		}
		v.Error = ""
		v.Selected = defaultSelection(v.Selected, info, manifest)
	})
	a.persist()
	t.Progress(3, 3)
	t.OK("探测完成")
	return nil
}

// defaultSelection：保留仍有效的已选 IP；否则选已部署的 IP；再否则选所有出口正常的 IPv4。
func defaultSelection(prev []string, info *model.ServerInfo, m *model.Manifest) []string {
	valid := map[string]bool{}
	for _, ad := range info.Addrs {
		valid[ad.IP] = true
	}
	var keep []string
	for _, ip := range prev {
		if valid[ip] {
			keep = append(keep, ip)
		}
	}
	if len(keep) > 0 {
		return keep
	}
	sel := map[string]bool{}
	if m != nil {
		for _, p := range m.Proxies {
			if valid[p.Listen] {
				sel[p.Listen] = true
			}
		}
	}
	if len(sel) == 0 {
		for _, ad := range info.Addrs {
			if ad.Family == 4 && ad.Probe != "fail" {
				sel[ad.IP] = true
			}
		}
	}
	var out []string
	for _, ad := range info.Addrs {
		if sel[ad.IP] {
			out = append(out, ad.IP)
		}
	}
	return out
}

func (a *App) probe(ctx context.Context, t *task.Task, c *sshx.Client, addrs []model.Addr) error {
	var list []string
	for _, ad := range addrs {
		if !ad.NeedBind {
			list = append(list, ad.IP)
		}
	}
	if len(list) == 0 {
		return nil
	}
	t.Step(fmt.Sprintf("实测 %d 个地址的出口公网 IP", len(list)))
	out, _, err := script(ctx, c, t, scripts.Probe, map[string][]byte{"addrs.txt": []byte(strings.Join(list, "\n") + "\n")}, nil, true)
	if err != nil {
		return err
	}
	res := detect.ParseProbe(out)
	detect.ApplyProbe(addrs, res)
	okc, nat := 0, 0
	for _, ad := range addrs {
		if ad.Probe == "ok" {
			okc++
			if ad.Public != ad.IP {
				nat++
			}
		}
	}
	msg := fmt.Sprintf("出口可用 %d/%d", okc, len(list))
	if nat > 0 {
		msg += fmt.Sprintf("，其中 %d 个为 NAT 映射（内网地址→公网 IP）", nat)
	}
	if okc < len(list) {
		t.Warn(msg)
	} else {
		t.OK(msg)
	}
	return nil
}

// Probe 手动添加地址并探测出口。
func (a *App) Probe(id string, text string, bind bool) (string, error) {
	ips, err := netx.Expand(text)
	if err != nil {
		return "", err
	}
	if len(ips) == 0 {
		return "", errors.New("没有可添加的地址")
	}
	return a.run(id, "probe", false, func(ctx context.Context, t *task.Task, s *Server) error {
		s.mu.Lock()
		if s.view.Info == nil {
			s.mu.Unlock()
			return errors.New("请先完成探测")
		}
		info := *s.view.Info
		addrs := append([]model.Addr(nil), info.Addrs...)
		defIf := info.DefaultIface
		s.mu.Unlock()
		have := map[string]int{}
		for i, ad := range addrs {
			have[ad.IP] = i
		}
		var fresh []model.Addr
		for _, ip := range ips {
			if _, ok := have[ip]; ok {
				continue
			}
			fam := netx.Family(ip)
			bits := 32
			if fam == 6 {
				bits = 128
			}
			ad := model.Addr{IP: ip, Prefix: bits, Iface: defIf, Family: fam, Source: "manual", NeedBind: bind}
			if bind {
				ad.Public = ip // 尚未绑定，无法实测出口，按公网地址处理
			}
			fresh = append(fresh, ad)
		}
		t.Info(fmt.Sprintf("新增 %d 个地址（%d 个已存在）", len(fresh), len(ips)-len(fresh)))
		if len(fresh) == 0 {
			return nil
		}
		if !bind {
			c, err := a.client(ctx, s, false)
			if err != nil {
				return err
			}
			if err := a.probe(ctx, t, c, fresh); err != nil {
				return err
			}
			for _, ad := range fresh {
				if ad.Probe == "fail" {
					t.Warn(ad.IP + " 不可用（不在网卡上？可勾选“自动绑定到网卡”）")
				}
			}
		}
		addrs = append(addrs, fresh...)
		detect.SortAddrs(addrs)
		a.update(s, func(v *model.ServerView) {
			ni := *v.Info
			ni.Addrs = addrs
			v.Info = &ni
			for _, ad := range fresh {
				if ad.Probe != "fail" {
					v.Selected = append(v.Selected, ad.IP)
				}
			}
		})
		a.persist()
		t.OK("已添加")
		return nil
	})
}

// ---------- 预览 / 部署 ----------

func (a *App) planInput(s *Server, req model.PlanRequest) (plan.Input, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.view.Info == nil {
		return plan.Input{}, errors.New("请先完成探测")
	}
	if s.adminPort == 0 {
		if s.view.Manifest != nil && s.view.Manifest.AdminPort != 0 {
			s.adminPort = s.view.Manifest.AdminPort
		} else {
			busy := map[string]bool{}
			for _, l := range s.view.Info.Listening {
				busy[l] = true
			}
			for {
				p := 30000 + int(time.Now().UnixNano()%9000)
				if !busy["127.0.0.1 "+strconv.Itoa(p)] && !busy["0.0.0.0 "+strconv.Itoa(p)] {
					s.adminPort = p
					break
				}
			}
		}
	}
	return plan.Input{
		Settings:  req.Settings,
		Addrs:     s.view.Info.Addrs,
		Selected:  req.Selected,
		Existing:  s.view.Manifest,
		Listening: s.view.Info.Listening,
		AdminPort: s.adminPort,
	}, nil
}

func (a *App) Plan(id string, req model.PlanRequest) (model.PlanResult, error) {
	s, err := a.get(id)
	if err != nil {
		return model.PlanResult{}, err
	}
	in, err := a.planInput(s, req)
	if err != nil {
		return model.PlanResult{}, err
	}
	if len(req.Edited) > 0 {
		res := model.PlanResult{Proxies: req.Edited, Errors: plan.Validate(req.Edited, in)}
		res.Ports = plan.PortSummary(req.Edited, req.Settings.UDP)
		return res, nil
	}
	key := planKey(req, in.Existing)
	s.mu.Lock()
	if s.lastPlanKey == key {
		res := s.lastPlan
		s.mu.Unlock()
		return res, nil
	}
	s.mu.Unlock()
	res := plan.Build(in)
	s.mu.Lock()
	s.lastPlanKey, s.lastPlan = key, res
	s.mu.Unlock()
	return res, nil
}

func planKey(req model.PlanRequest, m *model.Manifest) string {
	b, _ := json.Marshal(struct {
		S   model.Settings
		Sel []string
		M   time.Time
	}{req.Settings, req.Selected, manifestTime(m)})
	return string(b)
}

func manifestTime(m *model.Manifest) time.Time {
	if m == nil {
		return time.Time{}
	}
	return m.UpdatedAt
}

func (a *App) Deploy(id string, req model.PlanRequest, batch bool) (string, error) {
	s, err := a.get(id)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	hasInfo := s.view.Info != nil
	s.mu.Unlock()
	if !hasInfo && !batch {
		return "", errors.New("请先完成探测")
	}
	return a.run(id, "deploy", batch, func(ctx context.Context, t *task.Task, s *Server) error {
		err := a.deploy(ctx, t, s, req)
		if err != nil {
			a.setError(s, err)
		}
		return err
	})
}

func (a *App) deploy(ctx context.Context, t *task.Task, s *Server, req model.PlanRequest) error {
	s.mu.Lock()
	needDetect := s.view.Info == nil
	s.mu.Unlock()
	if needDetect {
		if err := a.detect(ctx, t, s, false); err != nil {
			return err
		}
	}
	s.mu.Lock()
	if len(req.Selected) == 0 {
		req.Selected = append([]string(nil), s.view.Selected...)
	}
	if len(req.Selected) == 0 && s.view.Info != nil {
		req.Selected = defaultSelection(nil, s.view.Info, s.view.Manifest)
	}
	s.mu.Unlock()

	res, err := a.Plan(s.view.ID, req)
	if err != nil {
		return err
	}
	for _, w := range res.Warnings {
		t.Warn(w)
	}
	if len(res.Errors) > 0 {
		for _, e := range res.Errors {
			t.Error(e)
		}
		return fmt.Errorf("配置有 %d 处错误，未部署", len(res.Errors))
	}
	a.update(s, func(v *model.ServerView) { v.State = "deploying"; v.Error = "" })

	s.mu.Lock()
	info := *s.view.Info
	old := s.view.Manifest
	adminPort := s.adminPort
	s.mu.Unlock()

	m := &model.Manifest{
		Version: 1, Tool: "AIO Proxy Tools " + a.Version, UpdatedAt: time.Now(),
		Settings: req.Settings, Proxies: res.Proxies, AdminPort: adminPort,
	}
	if old != nil && old.AdminUser != "" {
		m.AdminUser, m.AdminPass = old.AdminUser, old.AdminPass
	} else {
		m.AdminUser, m.AdminPass = "aioadm"+newID(3), newID(12)
	}
	hasV6 := false
	for _, ad := range info.Addrs {
		if ad.Family == 6 && ad.Source == "nic" {
			hasV6 = true
		}
	}
	b, err := threeproxy.Render(m, threeproxy.Options{ToolVersion: a.Version, CPUs: info.CPUs, MemMB: info.MemMB, HasIPv6: hasV6})
	if err != nil {
		return err
	}
	t.Info(fmt.Sprintf("共 %d 个代理，端口: %s", len(m.Proxies), strings.Join(res.Ports, ", ")))

	c, err := a.client(ctx, s, false)
	if err != nil {
		return err
	}
	body := scripts.WithCommon(scripts.Install)
	var out string
	var code int
	for attempt := 0; attempt < 2; attempt++ {
		out, code, err = script(ctx, c, t, body, b.Files, b.Env, false)
		if err != nil {
			return err
		}
		if code != 42 || attempt == 1 {
			break
		}
		// 服务器下载不了 3proxy：由本机下载（走本机代理环境变量）并上传
		needs := parseNeeds(out)
		if len(needs) == 0 {
			break
		}
		t.Step("服务器无法从 GitHub 下载 3proxy，改由本机下载后上传")
		got := 0
		for _, n := range needs {
			for _, name := range []string{n.sums, n.file} {
				if _, ok := b.Files["assets/"+name]; ok {
					continue
				}
				data, ferr := a.Fetcher.Get(ctx, threeproxy.Version, name, n.sums)
				if ferr != nil {
					t.Warn(ferr.Error())
					continue
				}
				b.Files["assets/"+name] = data
				got++
				t.OK(fmt.Sprintf("已下载并校验 %s（%d KB）", name, len(data)/1024))
			}
		}
		if got == 0 {
			return errors.New("本机也无法下载 3proxy，请检查网络或在设置中填写 GitHub 镜像")
		}
	}
	if code != 0 {
		return fmt.Errorf("部署失败（退出码 %d），请查看日志", code)
	}

	// 解析服务器自检结果
	tests := parseTests(out, "server", m)
	for _, line := range strings.Split(out, "\n") {
		if v, ok := strings.CutPrefix(line, "::dns::"); ok {
			m.DNSEffective = strings.TrimSpace(v)
		}
	}
	a.update(s, func(v *model.ServerView) {
		v.Manifest = m
		v.State = "deployed"
		v.Tests = tests
		v.Info.Installed = true
	})

	// 本机实测
	a.localTest(ctx, t, s, m.Proxies)
	return nil
}

type need struct{ kind, file, sums string }

func parseNeeds(out string) []need {
	var res []need
	for _, line := range strings.Split(out, "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(line), "::need::"); ok {
			f := strings.Fields(v)
			if len(f) == 3 {
				res = append(res, need{f[0], f[1], f[2]})
			}
		}
	}
	return res
}

func parseTests(out, where string, m *model.Manifest) []model.TestResult {
	expected := map[string]string{}
	for _, p := range m.Proxies {
		expected[p.ID] = p.Public
	}
	var res []model.TestResult
	for _, line := range strings.Split(out, "\n") {
		v, ok := strings.CutPrefix(strings.TrimSpace(line), "::test::")
		if !ok {
			continue
		}
		f := strings.Fields(v)
		if len(f) < 4 {
			continue
		}
		ms, _ := strconv.Atoi(f[3])
		r := model.TestResult{ProxyID: f[0], Where: where, LatencyMs: ms, Expected: expected[f[0]]}
		if f[1] == "ok" {
			r.OK = true
			r.Egress = netx.Canon(f[2])
			if r.Expected != "" && r.Egress != r.Expected {
				r.Error = fmt.Sprintf("出口 IP 为 %s，与预期 %s 不一致", r.Egress, r.Expected)
			}
		} else if f[2] == "DNS" {
			r.Error = "域名解析失败（代理可用，但 DNS 不通）"
		} else {
			r.Error = "服务器上无法通过该代理访问外网"
		}
		res = append(res, r)
	}
	return res
}

func mergeTests(old []model.TestResult, fresh []model.TestResult, where string) []model.TestResult {
	var out []model.TestResult
	for _, r := range old {
		if r.Where != where {
			out = append(out, r)
		}
	}
	return append(out, fresh...)
}

// ---------- 测试 ----------

func (a *App) localTest(ctx context.Context, t *task.Task, s *Server, ps []model.Proxy) []model.TestResult {
	t.Step(fmt.Sprintf("从本机测试 %d 个代理", len(ps)))
	t.Progress(0, len(ps))
	var mu sync.Mutex
	var res []model.TestResult
	tester.TestAll(ctx, ps, 32, false, func(r model.TestResult) {
		mu.Lock()
		res = append(res, r)
		mu.Unlock()
		t.AddDone(1)
	})
	okc := 0
	timeouts := 0
	for _, r := range res {
		if r.OK {
			okc++
		} else if strings.Contains(r.Error, "安全组") {
			timeouts++
		}
	}
	a.update(s, func(v *model.ServerView) { v.Tests = mergeTests(v.Tests, res, "local") })
	if okc == len(ps) {
		t.OK(fmt.Sprintf("本机实测全部通过 %d/%d", okc, len(ps)))
	} else {
		t.Warn(fmt.Sprintf("本机实测通过 %d/%d", okc, len(ps)))
		s.mu.Lock()
		serverOK := 0
		for _, r := range s.view.Tests {
			if r.Where == "server" && r.OK {
				serverOK++
			}
		}
		s.mu.Unlock()
		if timeouts > 0 && serverOK > 0 {
			t.Warn("服务器自检正常但本机连接超时：请到云厂商控制台的“安全组/防火墙”放行代理端口")
		}
	}
	return res
}

func (a *App) Test(id, where string, batch bool) (string, error) {
	return a.run(id, "test", batch, func(ctx context.Context, t *task.Task, s *Server) error {
		s.mu.Lock()
		m := s.view.Manifest
		s.mu.Unlock()
		if m == nil || len(m.Proxies) == 0 {
			return errors.New("该服务器还没有部署代理")
		}
		if where == "local" || where == "both" || where == "" {
			a.localTest(ctx, t, s, m.Proxies)
		}
		if where == "server" || where == "both" {
			c, err := a.client(ctx, s, false)
			if err != nil {
				return err
			}
			t.Step("服务器自检")
			b, err := threeproxy.Render(m, threeproxy.Options{ToolVersion: a.Version})
			if err != nil {
				return err
			}
			out, code, err := script(ctx, c, t, scripts.WithCommon(scripts.Ctl),
				map[string][]byte{"selftest.txt": b.Files["selftest.txt"]}, map[string]string{"ACTION": "test"}, false)
			if err != nil {
				return err
			}
			if code != 0 {
				return fmt.Errorf("服务器自检失败（退出码 %d）", code)
			}
			res := parseTests(out, "server", m)
			okc := 0
			for _, r := range res {
				if r.OK {
					okc++
				}
			}
			a.update(s, func(v *model.ServerView) { v.Tests = mergeTests(v.Tests, res, "server") })
			if okc == len(res) {
				t.OK(fmt.Sprintf("服务器自检通过 %d/%d", okc, len(res)))
			} else {
				t.Warn(fmt.Sprintf("服务器自检通过 %d/%d", okc, len(res)))
			}
		}
		return nil
	})
}

// ---------- 刷新 / 服务控制 / 卸载 ----------

func (a *App) readManifest(ctx context.Context, c *sshx.Client, t *task.Task) (*model.Manifest, *model.ServiceStatus) {
	out, _, err := script(ctx, c, t, scripts.WithCommon(scripts.Ctl), nil, map[string]string{"ACTION": "manifest"}, true)
	if err != nil {
		return nil, nil
	}
	var m *model.Manifest
	if body := between(out, "::manifest::begin", "::manifest::end"); body != "" {
		var mm model.Manifest
		if json.Unmarshal([]byte(body), &mm) == nil {
			m = &mm
		}
	}
	return m, parseStatus(out)
}

func between(s, a, b string) string {
	i := strings.Index(s, a)
	if i < 0 {
		return ""
	}
	s = s[i+len(a):]
	j := strings.Index(s, b)
	if j < 0 {
		return ""
	}
	return strings.TrimSpace(s[:j])
}

func parseStatus(out string) *model.ServiceStatus {
	st := &model.ServiceStatus{}
	found := false
	for _, line := range strings.Split(out, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		switch k {
		case "ACTIVE":
			st.Active, found = v == "1", true
		case "DNS_ACTIVE":
			st.DNSActive = v == "1"
		case "PID":
			st.PID, _ = strconv.Atoi(v)
		case "THREADS":
			st.Threads, _ = strconv.Atoi(v)
		case "RSS_KB":
			kb, _ := strconv.Atoi(v)
			st.MemMB = kb / 1024
		case "CONNS":
			st.Connections, _ = strconv.Atoi(v)
		case "SINCE":
			st.Since = v
		}
	}
	if !found {
		return nil
	}
	return st
}

func (a *App) Refresh(id string, batch bool) (string, error) {
	return a.run(id, "refresh", batch, func(ctx context.Context, t *task.Task, s *Server) error {
		c, err := a.client(ctx, s, false)
		if err != nil {
			a.setError(s, err)
			return err
		}
		t.Step("读取部署状态")
		m, st := a.readManifest(ctx, c, t)
		var stats []model.Stat
		if m != nil {
			t.Step("读取流量统计")
			out, _, err := script(ctx, c, t, scripts.WithCommon(scripts.Ctl), nil, map[string]string{"ACTION": "stats"}, true)
			if err == nil {
				stats = threeproxy.ParseCounters(between(out, "::counters::begin", "::counters::end"))
				if s2 := parseStatus(out); s2 != nil {
					st = s2
				}
			}
		}
		a.update(s, func(v *model.ServerView) {
			v.Manifest = m
			v.Status = st
			v.Stats = stats
			if m != nil {
				v.State = "deployed"
			} else if v.Info != nil {
				v.State = "ready"
			}
			v.Error = ""
		})
		if m == nil {
			t.Info("服务器上没有本工具部署的代理")
		} else {
			t.OK(fmt.Sprintf("%d 个代理，服务%s", len(m.Proxies), map[bool]string{true: "运行中", false: "未运行"}[st != nil && st.Active]))
		}
		return nil
	})
}

func (a *App) Service(id, action string) (string, error) {
	switch action {
	case "start", "stop", "restart":
	default:
		return "", errors.New("未知操作")
	}
	return a.run(id, "service", false, func(ctx context.Context, t *task.Task, s *Server) error {
		c, err := a.client(ctx, s, false)
		if err != nil {
			return err
		}
		t.Step(map[string]string{"start": "启动服务", "stop": "停止服务", "restart": "重启服务"}[action])
		out, code, err := script(ctx, c, t, scripts.WithCommon(scripts.Ctl), nil, map[string]string{"ACTION": action}, true)
		if err != nil {
			return err
		}
		st := parseStatus(out)
		a.update(s, func(v *model.ServerView) { v.Status = st })
		if code != 0 {
			return fmt.Errorf("操作失败（退出码 %d）", code)
		}
		if st != nil && st.Active {
			t.OK("服务运行中")
		} else {
			t.Info("服务已停止")
		}
		return nil
	})
}

func (a *App) Uninstall(id string) (string, error) {
	return a.run(id, "uninstall", false, func(ctx context.Context, t *task.Task, s *Server) error {
		c, err := a.client(ctx, s, false)
		if err != nil {
			return err
		}
		_, code, err := script(ctx, c, t, scripts.WithCommon(scripts.Uninstall), nil, nil, false)
		if err != nil {
			return err
		}
		if code != 0 {
			return fmt.Errorf("卸载失败（退出码 %d）", code)
		}
		a.update(s, func(v *model.ServerView) {
			v.Manifest = nil
			v.Tests = nil
			v.Stats = nil
			v.Status = nil
			v.State = "ready"
			if v.Info != nil {
				ni := *v.Info
				ni.Installed = false
				v.Info = &ni
			}
		})
		s.mu.Lock()
		s.adminPort = 0
		s.mu.Unlock()
		return nil
	})
}

// ---------- 批量 ----------

func (a *App) Batch(action string, ids []string, settings *model.Settings) (map[string]string, error) {
	out := map[string]string{}
	var errs []string
	for _, id := range ids {
		var tid string
		var err error
		switch action {
		case "detect":
			tid, err = a.Detect(id, false, true)
		case "deploy":
			if settings == nil {
				return nil, errors.New("批量部署需要提供设置")
			}
			tid, err = a.Deploy(id, model.PlanRequest{Settings: *settings}, true)
		case "test":
			tid, err = a.Test(id, "both", true)
		case "refresh":
			tid, err = a.Refresh(id, true)
		default:
			return nil, errors.New("未知批量操作")
		}
		if err != nil {
			v, _ := a.View(id)
			errs = append(errs, v.Host+": "+err.Error())
			continue
		}
		out[id] = tid
	}
	if len(out) == 0 && len(errs) > 0 {
		return nil, errors.New(strings.Join(errs, "；"))
	}
	return out, nil
}
