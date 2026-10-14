package threeproxy

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/model"
	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/plan"
)

func sampleManifest(listen string) *model.Manifest {
	s := plan.Defaults()
	s.UDP = true
	s.Whitelist = nil
	return &model.Manifest{
		Version:   1,
		Settings:  s,
		AdminPort: 21099,
		AdminUser: "adm0001",
		AdminPass: "AdminPass0001",
		Proxies: []model.Proxy{
			{ID: "socks-a", Listen: listen, Public: listen, Family: 4, Protocol: "socks", Port: 21080, User: "ua", Pass: "passA12345", Slot: 1,
				Limits: model.Limits{SpeedMbps: 8, MaxConn: 50, QuotaGB: 1, QuotaPeriod: "M"}},
			{ID: "http-a", Listen: listen, Public: listen, Family: 4, Protocol: "http", Port: 21081, User: "ua", Pass: "passA12345", Slot: 1},
			{ID: "auto-b", Listen: listen, Public: "203.0.113.7", Family: 4, Protocol: "auto", Port: 21082, User: "ub", Pass: "passB12345", Slot: 2,
				Limits: model.Limits{ExpiresAt: "2000-01-01"}, Whitelist: []string{"198.51.100.0/24"}},
		},
	}
}

func TestRender(t *testing.T) {
	m := sampleManifest("203.0.113.10")
	b, err := Render(m, Options{ToolVersion: "test", CPUs: 2, MemMB: 1024})
	if err != nil {
		t.Fatal(err)
	}
	cfg := string(b.Files["3proxy.cfg"])
	for _, want := range []string{
		"nserver 127.0.0.1:5335",
		`countall "1/ua" M 1024 ua`,
		`countall "2/ub" M 999999999 ub`,
		"bandlimin 8000000 ua",
		"connlim 50 0 ua",
		"socks -u2 -p21080 -i203.0.113.10 -e203.0.113.10",
		"proxy -a -p21081 -i203.0.113.10 -e203.0.113.10",
		"auto -a -p21082 -i203.0.113.10 -e203.0.113.10 -Ne203.0.113.7 -Ni203.0.113.7",
		"allow ub 198.51.100.0/24,203.0.113.10",
		"admin -p21099 -i127.0.0.1",
	} {
		if !strings.Contains(cfg, want) {
			t.Errorf("配置缺少 %q\n%s", want, cfg)
		}
	}
	if got := string(b.Files["expiry.list"]); got != "ub 2000-01-01\n" {
		t.Errorf("expiry.list = %q", got)
	}
	if got := string(b.Files["fw.txt"]); got != "tcp 21080:21082\nudp 40000:40999\n" {
		t.Errorf("fw.txt = %q", got)
	}
	// 供本机用 Windows 版 3proxy 实测：AIO_DUMP=<目录> AIO_LISTEN=<本机 IP>
	if dir := os.Getenv("AIO_DUMP"); dir != "" {
		m := sampleManifest(os.Getenv("AIO_LISTEN"))
		m.Settings.DNS.Mode = "public"
		b, _ := Render(m, Options{ToolVersion: "test"})
		c := string(b.Files["3proxy.cfg"])
		c = strings.ReplaceAll(c, "/etc/aio-proxy/users.active", filepath.ToSlash(filepath.Join(dir, "users.list")))
		c = strings.ReplaceAll(c, "/var/lib/aio-proxy/", filepath.ToSlash(dir)+"/")
		os.WriteFile(filepath.Join(dir, "3proxy.cfg"), []byte(c), 0o644)
		os.WriteFile(filepath.Join(dir, "users.list"), b.Files["users.list"], 0o644)
	}
}

func TestParseCounters(t *testing.T) {
	html := `<tr><td>countall</td><td>1/p1</td><td><A HREF='/CD0'>YES</A></td><td>uA</td><td><center>ANY</center></td><td><center>ANY</center></td><td><center>ANY</center></td><td>100000</td><td>MB/month</td><td>4.7</td><td>Wed Oct 14 00:06:54 2026
</td><td>never</td><td>1</td></tr>
<tr><td>countall</td><td>2/p2</td><td><A HREF='/CD1'>YES</A></td><td>uB</td><td><center>ANY</center></td><td><center>ANY</center></td><td><center>ANY</center></td><td>999999999</td><td>MB/day</td><td>1.0</td><td>x</td><td>never</td><td>2</td></tr>`
	st := ParseCounters(html)
	if len(st) != 2 || st[0].UsedMB != 4.7 || st[0].LimitMB != 100000 || st[0].User != "p1" || st[1].LimitMB != 0 || st[1].Period != "D" {
		t.Fatalf("解析结果不对: %+v", st)
	}
}
