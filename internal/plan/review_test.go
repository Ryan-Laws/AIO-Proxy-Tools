package plan

import (
	"strings"
	"testing"

	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/model"
)

// 重新部署时共享账号模式应沿用同一个账号，新加入的 IP 也用它
func TestSharedKeepsOneAccountOnRedeploy(t *testing.T) {
	s := Defaults()
	s.Protocol = "socks"
	s.Auth.Mode = "shared"
	s.KeepExisting = true
	first := Build(Input{Settings: s, Addrs: addrs(), Selected: []string{"203.0.113.10"}})
	if len(first.Errors) > 0 {
		t.Fatal(first.Errors)
	}
	old := &model.Manifest{Settings: s, Proxies: first.Proxies}
	second := Build(Input{Settings: s, Addrs: addrs(), Selected: []string{"203.0.113.10", "203.0.113.11"}, Existing: old})
	if len(second.Errors) > 0 {
		t.Fatal(second.Errors)
	}
	for _, p := range second.Proxies {
		if p.User != first.Proxies[0].User || p.Pass != first.Proxies[0].Pass {
			t.Fatalf("共享账号应保持为 %s，%s 却是 %s", first.Proxies[0].User, p.Listen, p.User)
		}
	}
}

// 删除账号后再加新账号，新账号不能复用旧槽位（否则继承旧账号的已用流量）
func TestSlotsNeverReused(t *testing.T) {
	s := Defaults()
	s.Protocol = "socks"
	s.KeepExisting = true
	a := Build(Input{Settings: s, Addrs: addrs(), Selected: []string{"203.0.113.10", "203.0.113.11"}})
	maxSlot := 0
	for _, p := range a.Proxies {
		if p.Slot > maxSlot {
			maxSlot = p.Slot
		}
	}
	// 只保留第一个 IP（槽位最大的账号被删除）
	m := &model.Manifest{Settings: s, Proxies: a.Proxies[:1], MaxSlot: maxSlot}
	b := Build(Input{Settings: s, Addrs: addrs(), Selected: []string{"203.0.113.10", "10.0.0.5"}, Existing: m})
	for _, p := range b.Proxies {
		if p.Listen == "10.0.0.5" && p.Slot <= maxSlot {
			t.Fatalf("新账号槽位 %d 复用了已分配过的槽位（最大 %d）", p.Slot, maxSlot)
		}
	}
}

func TestNoAuthRequiresWhitelist(t *testing.T) {
	s := Defaults()
	s.Auth.Mode = "none"
	if res := Build(Input{Settings: s, Addrs: addrs(), Selected: []string{"203.0.113.10"}}); len(res.Errors) == 0 {
		t.Fatal("无认证且无白名单应报错")
	}
	s.Whitelist = []string{"198.51.100.0/24"}
	if res := Build(Input{Settings: s, Addrs: addrs(), Selected: []string{"203.0.113.10"}}); len(res.Errors) > 0 {
		t.Fatal(res.Errors)
	}
}

func TestNATSharedPublicWarns(t *testing.T) {
	s := Defaults()
	as := []model.Addr{
		{IP: "10.0.0.1", Family: 4, Iface: "eth0", Public: "198.51.100.9", Probe: "ok"},
		{IP: "10.0.0.2", Family: 4, Iface: "eth0", Public: "198.51.100.9", Probe: "ok"},
	}
	res := Build(Input{Settings: s, Addrs: as, Selected: []string{"10.0.0.1", "10.0.0.2"}})
	if !strings.Contains(strings.Join(res.Warnings, "\n"), "198.51.100.9:1080") {
		t.Fatalf("应提示公网地址重复: %v", res.Warnings)
	}
}

// 写进配置的字段不能带换行、空格等（防止注入 3proxy 指令）
func TestRejectsConfigInjection(t *testing.T) {
	bad := []func(*model.Settings){
		func(s *model.Settings) {
			s.DNS = model.DNSRule{Mode: "forward", Servers: []string{"1.1.1.1\nauth none"}}
		},
		func(s *model.Settings) { s.Whitelist = []string{"1.2.3.4 *"} },
		func(s *model.Settings) { s.GitHubMirror = "http://mirror.example.com/" },
		func(s *model.Settings) { s.StopConflicts = []string{"x; rm -rf /"} },
		func(s *model.Settings) { s.Limits.ExpiresAt = "2026-01-01\nallow *" },
		func(s *model.Settings) { s.Socks = model.PortRule{Mode: "random", RangeMin: 9000, RangeMax: 100} },
		func(s *model.Settings) { s.Auth.PassLen = 6 },
	}
	for i, f := range bad {
		s := Defaults()
		f(&s)
		if len(ValidateSettings(s)) == 0 {
			t.Errorf("第 %d 个非法设置没有被拒绝", i)
		}
	}
	if errs := ValidateSettings(Defaults()); len(errs) > 0 {
		t.Fatalf("默认设置不应报错: %v", errs)
	}
	ok := Defaults()
	ok.DNS = model.DNSRule{Mode: "custom", Servers: []string{"1.1.1.1", "9.9.9.9:53", "[2606:4700:4700::1111]:53"}}
	ok.GitHubMirror = "https://mirror.example.com/"
	if errs := ValidateSettings(ok); len(errs) > 0 {
		t.Fatalf("合法设置不应报错: %v", errs)
	}

	in := Input{Addrs: addrs()}
	edited := []model.Proxy{{ID: "socks-203_0_113_10", Listen: "203.0.113.10", Public: "203.0.113.10\nallow *",
		Protocol: "socks", Port: 1080, User: "u1", Pass: "secret123"}}
	if len(Validate(edited, in)) == 0 {
		t.Fatal("预览表里被篡改的公网地址应被拒绝")
	}
	edited[0].Public, edited[0].Iface = "203.0.113.10", "eth0;reboot"
	if len(Validate(edited, in)) == 0 {
		t.Fatal("非法网卡名应被拒绝")
	}
}
