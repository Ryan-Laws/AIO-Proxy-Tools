package app

import (
	"testing"

	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/model"
)

func TestParseBatchEdgeCases(t *testing.T) {
	cases := []struct {
		line string
		want model.ServerInput
	}{
		// 密码里有逗号、连续空格：按空格格式解析，密码原样保留
		{"203.0.113.10 root pa,ss", model.ServerInput{Host: "203.0.113.10", Port: 22, User: "root", Password: "pa,ss"}},
		{"203.0.113.10:2222 admin a  b", model.ServerInput{Host: "203.0.113.10", Port: 2222, User: "admin", Password: "a  b"}},
		{"[2001:db8::1]:2200 root pw", model.ServerInput{Host: "2001:db8::1", Port: 2200, User: "root", Password: "pw"}},
		// CSV：支持引号包住带逗号的密码，端口留空用默认
		{`203.0.113.11,,ubuntu,"x,y"`, model.ServerInput{Host: "203.0.113.11", Port: 22, User: "ubuntu", Password: "x,y"}},
		{"203.0.113.12,2022,root,secret", model.ServerInput{Host: "203.0.113.12", Port: 2022, User: "root", Password: "secret"}},
		{"203.0.113.13", model.ServerInput{Host: "203.0.113.13", Port: 22, User: "root"}},
	}
	for _, c := range cases {
		got, errs := ParseBatch(c.line, 22, "root", "password")
		if len(errs) > 0 || len(got) != 1 {
			t.Errorf("%q: 解析失败 %v %v", c.line, got, errs)
			continue
		}
		g := got[0]
		if g.Host != c.want.Host || g.Port != c.want.Port || g.User != c.want.User || g.Password != c.want.Password {
			t.Errorf("%q: 得到 %s:%d %s/%q，应为 %s:%d %s/%q", c.line, g.Host, g.Port, g.User, g.Password,
				c.want.Host, c.want.Port, c.want.User, c.want.Password)
		}
	}
	if got, _ := ParseBatch("host,port,user,password\n# 注释\n\n203.0.113.14,22,root,pw", 22, "root", "password"); len(got) != 1 {
		t.Errorf("表头、注释、空行应被跳过: %v", got)
	}
}

// 主机栏写了端口时以它为准（界面总会带上默认端口 22）
func TestNormalizeHostPort(t *testing.T) {
	for _, c := range []struct {
		host string
		port int
		wh   string
		wp   int
	}{
		{"203.0.113.10:2222", 22, "203.0.113.10", 2222},
		{"[2001:db8::1]:2200", 22, "2001:db8::1", 2200},
		{"2001:db8::1", 22, "2001:db8::1", 22},
		{"vps.example.com", 0, "vps.example.com", 22},
	} {
		in := model.ServerInput{Host: c.host, Port: c.port, Password: "x"}
		if err := normalizeInput(&in); err != nil || in.Host != c.wh || in.Port != c.wp {
			t.Errorf("%s → %s:%d（%v），应为 %s:%d", c.host, in.Host, in.Port, err, c.wh, c.wp)
		}
	}
}
