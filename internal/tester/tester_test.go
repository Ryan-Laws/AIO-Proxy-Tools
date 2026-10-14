package tester

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/model"
)

// 需要真实 3proxy：AIO_3PROXY=<3proxy 可执行文件> AIO_LISTEN=<本机网卡 IP> go test ./internal/tester/
func TestAgainst3proxy(t *testing.T) {
	bin, listen := os.Getenv("AIO_3PROXY"), os.Getenv("AIO_LISTEN")
	if bin == "" || listen == "" {
		t.Skip("未设置 AIO_3PROXY / AIO_LISTEN")
	}
	dir := t.TempDir()
	cfg := "nserver 1.1.1.1\nnscache 65536\nauth strong\nusers ua:CL:passA12345\n" +
		"allow ua\nsocks -u2 -p21180 -i" + listen + " -e" + listen + "\n" +
		"proxy -a -p21181 -i" + listen + " -e" + listen + "\n" +
		"auto -a -p21182 -i" + listen + " -e" + listen + "\n"
	p := filepath.Join(dir, "t.cfg")
	os.WriteFile(p, []byte(cfg), 0o644)
	cmd := exec.Command(bin, p)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	time.Sleep(time.Second)

	ctx := context.Background()
	for _, c := range []struct {
		proto string
		port  int
	}{{"socks", 21180}, {"http", 21181}, {"auto", 21182}} {
		r := Test(ctx, model.Proxy{ID: c.proto, Listen: listen, Family: 4, Protocol: c.proto, Port: c.port, User: "ua", Pass: "passA12345"})
		if !r.OK || r.Egress == "" || r.AuthOK == nil || !*r.AuthOK {
			t.Errorf("%s: %+v", c.proto, r)
		} else {
			t.Logf("%s ok egress=%s %dms", c.proto, r.Egress, r.LatencyMs)
		}
		bad := Test(ctx, model.Proxy{ID: c.proto, Listen: listen, Family: 4, Protocol: c.proto, Port: c.port, User: "ua", Pass: "wrongpass"})
		if bad.OK {
			t.Errorf("%s: 错误密码不应通过", c.proto)
		} else {
			t.Logf("%s 错误密码: %s", c.proto, bad.Error)
		}
	}
	r := Test(ctx, model.Proxy{ID: "x", Listen: listen, Family: 4, Protocol: "socks", Port: 21189, User: "ua", Pass: "passA12345"})
	t.Logf("未监听端口: %s", r.Error)
}
