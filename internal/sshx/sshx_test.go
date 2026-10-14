package sshx

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// testServer 是进程内的 SSH 服务器，用本机 bash 执行命令（Windows 上需要 Git Bash）。
func testServer(t *testing.T, password string) (addr string, stop func()) {
	t.Helper()
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("需要 bash")
	}
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	signer, _ := ssh.NewSignerFromKey(priv)
	cfg := &ssh.ServerConfig{PasswordCallback: func(c ssh.ConnMetadata, p []byte) (*ssh.Permissions, error) {
		if string(p) == password {
			return nil, nil
		}
		return nil, errors.New("bad password")
	}}
	cfg.AddHostKey(signer)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			nc, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				_, chans, reqs, err := ssh.NewServerConn(nc, cfg)
				if err != nil {
					return
				}
				go ssh.DiscardRequests(reqs)
				for nch := range chans {
					ch, creqs, _ := nch.Accept()
					go func() {
						defer ch.Close()
						for req := range creqs {
							if req.Type != "exec" {
								req.Reply(false, nil)
								continue
							}
							n := binary.BigEndian.Uint32(req.Payload)
							cmd := string(req.Payload[4 : 4+n])
							req.Reply(true, nil)
							code := 0
							if cmd == "id -u" {
								io.WriteString(ch, "0\n")
							} else {
								c := exec.Command(bash, "-c", cmd)
								c.Stdin, c.Stdout, c.Stderr = ch, ch, ch.Stderr()
								if err := c.Run(); err != nil {
									var ee *exec.ExitError
									if errors.As(err, &ee) {
										code = ee.ExitCode()
									} else {
										code = 127
									}
								}
							}
							ch.SendRequest("exit-status", false, ssh.Marshal(struct{ C uint32 }{uint32(code)}))
							return
						}
					}()
				}
			}()
		}
	}()
	return ln.Addr().String(), func() { ln.Close() }
}

func TestRunScript(t *testing.T) {
	addr, stop := testServer(t, "s3cret")
	defer stop()
	host, port, _ := net.SplitHostPort(addr)
	var p int
	for _, c := range port {
		p = p*10 + int(c-'0')
	}
	kh := NewKnownHosts(filepath.Join(t.TempDir(), "known_hosts"))
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if _, err := Dial(ctx, Config{Host: host, Port: p, User: "root", Password: "wrong"}, kh); err == nil ||
		!strings.Contains(err.Error(), "认证失败") {
		t.Fatalf("错误密码应提示认证失败: %v", err)
	}
	c, err := Dial(ctx, Config{Host: host, Port: p, User: "root", Password: "s3cret"}, kh)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if !c.IsRoot() || c.Fingerprint == "" {
		t.Fatalf("root=%v fp=%q", c.IsRoot(), c.Fingerprint)
	}

	var lines []string
	code, err := c.RunScript(ctx, Script{
		Body:  "cd \"$(dirname \"$0\")\"; echo \"::step::$GREETING\"; cat data/in.txt; printf 'x\\033[31my\\033[0m\\n'; exit 7",
		Files: map[string][]byte{"data/in.txt": []byte("第一行\n含 'quote' 和 $HOME\n")},
		Env:   map[string]string{"GREETING": "hi 'there' $USER"},
		OnLine: func(l string) {
			lines = append(lines, l)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if code != 7 {
		t.Errorf("退出码 %d，应为 7", code)
	}
	got := strings.Join(lines, "|")
	want := "::step::hi 'there' $USER|第一行|含 'quote' 和 $HOME|xy"
	if got != want {
		t.Errorf("输出\n got %q\nwant %q", got, want)
	}

	// 服务器换了主机密钥 → 必须拒绝，除非用户确认信任
	stop()
	addr2, stop2 := testServer(t, "s3cret")
	defer stop2()
	_, port2, _ := net.SplitHostPort(addr2)
	_ = port2
	// 用同一个 known_hosts 条目模拟：把新服务器的地址映射到旧记录
	kh2 := NewKnownHosts(filepath.Join(t.TempDir(), "kh"))
	h2, p2s, _ := net.SplitHostPort(addr2)
	var p2 int
	for _, ch := range p2s {
		p2 = p2*10 + int(ch-'0')
	}
	if _, err := Dial(ctx, Config{Host: h2, Port: p2, Password: "s3cret"}, kh2); err != nil {
		t.Fatal(err)
	}
	stop2()
	addr3, stop3 := testServer(t, "s3cret")
	defer stop3()
	// 新服务器监听在不同端口，把 kh2 中记录改写到新端口来模拟"同一地址换了密钥"
	data := readFile(t, kh2.path)
	_, p3s, _ := net.SplitHostPort(addr3)
	writeFile(t, kh2.path, strings.ReplaceAll(data, "]:"+p2s+" ", "]:"+p3s+" "))
	var p3 int
	for _, ch := range p3s {
		p3 = p3*10 + int(ch-'0')
	}
	_, err = Dial(ctx, Config{Host: h2, Port: p3, Password: "s3cret"}, kh2)
	var hke *HostKeyError
	if !errors.As(err, &hke) {
		t.Fatalf("主机密钥变化应返回 HostKeyError，得到 %v", err)
	}
	if _, err := Dial(ctx, Config{Host: h2, Port: p3, Password: "s3cret", TrustNewKey: true}, kh2); err != nil {
		t.Fatalf("信任新密钥后应能连接: %v", err)
	}
	if _, err := Dial(ctx, Config{Host: h2, Port: p3, Password: "s3cret"}, kh2); err != nil {
		t.Fatalf("更新记录后再次连接应成功: %v", err)
	}
}

func readFile(t *testing.T, p string) string {
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func writeFile(t *testing.T, p, s string) {
	if err := os.WriteFile(p, []byte(s), 0o600); err != nil {
		t.Fatal(err)
	}
}
