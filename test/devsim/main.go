// devsim 是开发用的模拟服务器：一个本地 SSH 服务，假装是一台多 IP 的 Linux VPS，
// 对探测 / 出口探测 / 安装 / 运维 / 卸载脚本返回逼真的输出，用于在没有真实服务器时联调界面。
// 所有地址均为文档保留地址（203.0.113.0/24、198.51.100.0/24、2001:db8::/32）。
//
//	go run ./test/devsim            # 监听 127.0.0.1:2222，任意用户名，密码 devsim
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	mrand "math/rand/v2"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

var (
	stateDir string
	mu       sync.Mutex
	files    = map[string][]byte{} // 模拟的远程文件系统（只存上传的临时文件）
)

func main() {
	addr := flag.String("listen", "127.0.0.1:2222", "监听地址")
	pw := flag.String("password", "devsim", "SSH 密码")
	flag.Parse()
	stateDir = filepath.Join(os.TempDir(), "aio-devsim")
	os.MkdirAll(stateDir, 0o755)

	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	signer, _ := ssh.NewSignerFromKey(priv)
	cfg := &ssh.ServerConfig{PasswordCallback: func(c ssh.ConnMetadata, p []byte) (*ssh.Permissions, error) {
		if string(p) == *pw {
			return nil, nil
		}
		return nil, fmt.Errorf("bad password")
	}}
	cfg.AddHostKey(signer)
	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("模拟服务器: ssh root@%s 密码 %s（每次启动主机密钥都会变化，需在界面中信任新密钥）", *addr, *pw)
	for {
		nc, err := ln.Accept()
		if err != nil {
			return
		}
		go serve(nc, cfg)
	}
}

func serve(nc net.Conn, cfg *ssh.ServerConfig) {
	_, chans, reqs, err := ssh.NewServerConn(nc, cfg)
	if err != nil {
		return
	}
	go ssh.DiscardRequests(reqs)
	for nch := range chans {
		if nch.ChannelType() != "session" {
			nch.Reject(ssh.UnknownChannelType, "")
			continue
		}
		ch, creqs, _ := nch.Accept()
		go func() {
			defer ch.Close()
			for req := range creqs {
				if req.Type != "exec" {
					req.Reply(req.Type == "env", nil)
					continue
				}
				n := binary.BigEndian.Uint32(req.Payload)
				cmd := string(req.Payload[4 : 4+n])
				req.Reply(true, nil)
				code := handle(cmd, ch)
				ch.SendRequest("exit-status", false, ssh.Marshal(struct{ C uint32 }{uint32(code)}))
				return
			}
		}()
	}
}

var (
	reCat  = regexp.MustCompile(`cat > '([^']+)'`)
	reRun  = regexp.MustCompile(`env (.*)sh '([^']+)/main\.sh'`)
	reEnvs = regexp.MustCompile(`([A-Z_]+)='((?:[^']|'\\'')*)'`)
)

func handle(cmd string, ch ssh.Channel) int {
	switch {
	case cmd == "id -u":
		fmt.Fprintln(ch, "0")
	case strings.Contains(cmd, "mktemp -d"):
		fmt.Fprintf(ch, "/tmp/aio-proxy.%06d\n", mrand.IntN(1000000))
	case strings.Contains(cmd, "cat > "):
		m := reCat.FindStringSubmatch(cmd)
		b, _ := io.ReadAll(ch)
		mu.Lock()
		files[m[1]] = b
		mu.Unlock()
	case strings.Contains(cmd, "rm -rf"):
	case reRun.MatchString(cmd):
		m := reRun.FindStringSubmatch(cmd)
		env := map[string]string{}
		for _, e := range reEnvs.FindAllStringSubmatch(m[1], -1) {
			env[e[1]] = strings.ReplaceAll(e[2], `'\''`, "'")
		}
		dir := m[2]
		mu.Lock()
		body := string(files[dir+"/main.sh"])
		get := func(name string) string { return string(files[dir+"/"+name]) }
		mu.Unlock()
		return runScript(ch, body, env, get)
	default:
		fmt.Fprintf(ch, "devsim: 未模拟的命令 %q\n", cmd)
		return 127
	}
	return 0
}

// ---------- 模拟的服务器 ----------

var nicAddrs = func() []string {
	var a []string
	for i := 10; i < 26; i++ {
		a = append(a, fmt.Sprintf("ADDR4=eth0 203.0.113.%d/24", i))
	}
	a = append(a, "ADDR4=eth1 10.0.0.5/24", "ADDR6=eth0 2001:db8::10/64")
	return a
}()

func runScript(w io.Writer, body string, env map[string]string, get func(string) string) int {
	say := func(f string, a ...any) { fmt.Fprintf(w, f+"\n", a...) }
	pause := func(ms int) { time.Sleep(time.Duration(ms) * time.Millisecond) }
	installed := exists("proxies.json")
	switch {
	case strings.Contains(body, "DETECT_DONE"):
		pause(400)
		say("OS=Ubuntu 24.04.1 LTS (模拟)\nOS_ID=ubuntu\nOS_VERSION=24.04\nKERNEL=6.8.0-45-generic\nARCH=x86_64\nUID=0\nCPUS=4\nMEM_KB=4026532")
		say("INIT=systemd\nPM=apt-get\nHAS_CURL=1\nFW=ufw\nTCP_CC=cubic\nCONFLICTS=\nDEFIF=eth0")
		if installed {
			say("INSTALLED=1\nVERSION=dev")
		}
		say(strings.Join(nicAddrs, "\n"))
		say("ANYIP4=lo 198.51.100.64/29")
		say("LISTEN=0.0.0.0:22 [::]:22 127.0.0.53:53")
		say("DETECT_DONE=1")
	case strings.Contains(body, "EGRESS="):
		for _, ip := range strings.Fields(get("addrs.txt")) {
			pause(15)
			switch {
			case ip == "10.0.0.5":
				say("EGRESS=%s 198.51.100.7", ip)
			case ip == "203.0.113.25":
				say("EGRESS=%s FAIL", ip)
			default:
				say("EGRESS=%s %s", ip, ip)
			}
		}
		say("PROBE_DONE=1")
	case strings.Contains(body, "安装 / 更新"):
		steps := []string{"::step::检查依赖", "::ok::依赖就绪", "::step::安装 3proxy " + env["TP_VERSION"],
			"::info::尝试官方安装包 3proxy-" + env["TP_VERSION"] + ".x86_64.deb", "::ok::3proxy 安装完成",
			"::step::检查端口占用", "::ok::端口可用", "::step::配置本机 DNS 解析器（unbound）",
			"::ok::unbound 已启动（127.0.0.1:5335，模式: " + env["DNS_MODE"] + "）", "::step::写入配置",
			"::step::优化内核参数", "::ok::BBR 已开启", "::step::注册系统服务", "::step::启动 3proxy"}
		for _, s := range steps {
			pause(250)
			say(s)
		}
		lines := strings.Split(strings.TrimSpace(get("listen.txt")), "\n")
		say("::ok::3proxy 运行中，%d 个监听全部就绪", len(lines))
		say("::step::放行防火墙端口")
		for _, l := range strings.Split(strings.TrimSpace(get("fw.txt")), "\n") {
			say("::info::ufw allow %s", l)
		}
		say("::ok::已放行: ufw")
		say("::step::服务器自检")
		pause(500)
		selftest(w, get("selftest.txt"), get("proxies.json"))
		os.WriteFile(filepath.Join(stateDir, "proxies.json"), []byte(get("proxies.json")), 0o644)
		say("::dns::%s", env["DNS_MODE"])
		say("::ok::部署完成")
	case strings.Contains(body, "运维操作"):
		status := func() {
			if installed {
				say("ACTIVE=1\nDNS_ACTIVE=1\nPID=4242\nTHREADS=%d\nRSS_KB=%d\nCONNS=%d\nSINCE=Tue 2026-10-13 21:00:00 UTC",
					20+mrand.IntN(30), 9000+mrand.IntN(4000), mrand.IntN(60))
			} else {
				say("ACTIVE=0\nDNS_ACTIVE=0")
			}
		}
		switch env["ACTION"] {
		case "manifest":
			if installed {
				b, _ := os.ReadFile(filepath.Join(stateDir, "proxies.json"))
				say("::manifest::begin\n%s\n::manifest::end", b)
			}
			status()
		case "stats":
			status()
			say("::counters::begin")
			b, _ := os.ReadFile(filepath.Join(stateDir, "proxies.json"))
			var m struct {
				Proxies []struct {
					User   string `json:"user"`
					Slot   int    `json:"slot"`
					Limits struct {
						QuotaGB     float64 `json:"quotaGB"`
						QuotaPeriod string  `json:"quotaPeriod"`
					} `json:"limits"`
				} `json:"proxies"`
			}
			json.Unmarshal(b, &m)
			seen := map[string]bool{}
			for _, p := range m.Proxies {
				if seen[p.User] || p.User == "" {
					continue
				}
				seen[p.User] = true
				limit := 999999999.0
				if p.Limits.QuotaGB > 0 {
					limit = p.Limits.QuotaGB * 1024
				}
				say("<tr><td>countall</td><td>%d/%s</td><td>YES</td><td>%s</td><td>ANY</td><td>ANY</td><td>ANY</td><td>%.0f</td><td>MB/month</td><td>%.1f</td><td>x</td><td>never</td><td>%d</td></tr>",
					p.Slot, p.User, p.User, limit, mrand.Float64()*2048, p.Slot)
			}
			say("::counters::end")
		case "test":
			selftest(w, get("selftest.txt"), "")
		default:
			pause(600)
			status()
		}
	case strings.Contains(body, "卸载"):
		for _, s := range []string{"::step::停止服务", "::step::撤销防火墙规则", "::step::删除文件"} {
			pause(300)
			say(s)
		}
		os.Remove(filepath.Join(stateDir, "proxies.json"))
		say("::ok::已卸载")
	default:
		say("::error::devsim 无法识别该脚本")
		return 1
	}
	return 0
}

func selftest(w io.Writer, list, manifest string) {
	for _, line := range strings.Split(strings.TrimSpace(list), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		egress := f[1]
		if egress == "10.0.0.5" {
			egress = "198.51.100.7"
		}
		fmt.Fprintf(w, "::test::%s ok %s %d\n", f[0], egress, 80+mrand.IntN(200))
	}
	n := len(strings.Split(strings.TrimSpace(list), "\n"))
	fmt.Fprintf(w, "::ok::自检通过 %d/%d\n", n, n)
}

func exists(name string) bool {
	_, err := os.Stat(filepath.Join(stateDir, name))
	return err == nil
}
