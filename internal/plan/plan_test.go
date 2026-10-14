package plan

import (
	"strings"
	"testing"

	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/model"
)

func addrs() []model.Addr {
	return []model.Addr{
		{IP: "203.0.113.10", Family: 4, Iface: "eth0", Public: "203.0.113.10", Probe: "ok"},
		{IP: "203.0.113.11", Family: 4, Iface: "eth0", Public: "203.0.113.11", Probe: "ok"},
		{IP: "10.0.0.5", Family: 4, Iface: "eth0", Public: "198.51.100.7", Probe: "ok"},
	}
}

func TestBuildDualPerIP(t *testing.T) {
	s := Defaults()
	res := Build(Input{Settings: s, Addrs: addrs(), Selected: []string{"203.0.113.10", "203.0.113.11", "10.0.0.5"}, AdminPort: 31000})
	if len(res.Errors) > 0 {
		t.Fatal(res.Errors)
	}
	if len(res.Proxies) != 6 {
		t.Fatalf("双协议 3 个 IP 应生成 6 个代理，得到 %d", len(res.Proxies))
	}
	users := map[string]string{}
	for _, p := range res.Proxies {
		if prev, ok := users[p.Listen]; ok && prev != p.User {
			t.Errorf("同一 IP 的两个协议应共用账号")
		}
		users[p.Listen] = p.User
		if !ValidCred(p.User, 1) || len(p.Pass) != 16 {
			t.Errorf("账号不合法 %s/%s", p.User, p.Pass)
		}
		if p.Listen == "10.0.0.5" && p.Public != "198.51.100.7" {
			t.Errorf("NAT 地址应使用公网 IP 连接: %+v", p)
		}
	}
	if len(map[string]bool{users["203.0.113.10"]: true, users["203.0.113.11"]: true}) != 2 {
		t.Errorf("每 IP 独立账号应不同")
	}
	if strings.Join(res.Ports, ",") != "tcp 1080,tcp 8080" {
		t.Errorf("端口摘要 %v", res.Ports)
	}
}

func TestBuildIncAndConflicts(t *testing.T) {
	s := Defaults()
	s.Protocol = "socks"
	s.Socks = model.PortRule{Mode: "inc", Port: 20000}
	s.Auth = model.AuthRule{Mode: "custom", User: "alice", Pass: "secret123"}
	res := Build(Input{Settings: s, Addrs: addrs(), Selected: []string{"203.0.113.10", "203.0.113.11"},
		Listening: []string{"203.0.113.11 20001"}})
	if len(res.Errors) != 1 || !strings.Contains(res.Errors[0], "203.0.113.11:20001") {
		t.Fatalf("应检测到端口冲突: %v", res.Errors)
	}
	res = Build(Input{Settings: s, Addrs: addrs(), Selected: []string{"203.0.113.10", "203.0.113.11"},
		Listening: []string{"0.0.0.0 20000"}})
	if len(res.Errors) == 0 {
		t.Fatal("0.0.0.0 上的同端口应视为冲突")
	}
}

func TestKeepExisting(t *testing.T) {
	s := Defaults()
	s.Protocol = "socks"
	s.Socks = model.PortRule{Mode: "random", RangeMin: 20000, RangeMax: 30000}
	old := &model.Manifest{AdminPort: 31000, Proxies: []model.Proxy{
		{Listen: "203.0.113.10", Protocol: "socks", Port: 23456, User: "olduser", Pass: "oldpass123", Slot: 7},
	}}
	res := Build(Input{Settings: s, Addrs: addrs(), Selected: []string{"203.0.113.10", "203.0.113.11"}, Existing: old,
		Listening: []string{"203.0.113.10 23456"}, AdminPort: 31000})
	if len(res.Errors) > 0 {
		t.Fatal(res.Errors)
	}
	p := res.Proxies[0]
	if p.Port != 23456 || p.User != "olduser" || p.Slot != 7 {
		t.Errorf("应沿用原端口/账号/计数槽: %+v", p)
	}
	if res.Proxies[1].Slot != 8 {
		t.Errorf("新账号应分配新槽位: %+v", res.Proxies[1])
	}
}

func TestValidateEdited(t *testing.T) {
	in := Input{Addrs: addrs(), AdminPort: 31000}
	errs := Validate([]model.Proxy{
		{Listen: "203.0.113.10", Port: 1080, Protocol: "socks", User: "a", Pass: "bad:pass"},
		{Listen: "203.0.113.10", Port: 1080, Protocol: "socks", User: "a", Pass: "other123"},
		{Listen: "192.0.2.1", Port: 31000, Protocol: "http"},
	}, in)
	if len(errs) < 4 {
		t.Errorf("应发现多处错误: %v", errs)
	}
}
