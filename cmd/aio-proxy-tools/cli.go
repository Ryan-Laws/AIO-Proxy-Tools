package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/app"
	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/model"
	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/store"
	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/tester"
)

// runCLI 实现无界面的命令行模式，适合无桌面环境与自动化测试。
//
//	aio-proxy-tools deploy    -host 203.0.113.10 [选项]
//	aio-proxy-tools test      -host 203.0.113.10
//	aio-proxy-tools uninstall -host 203.0.113.10
//
// SSH 密码从环境变量 AIO_SSH_PASSWORD 读取（避免出现在命令行历史中），私钥用 -key 指定文件。
func runCLI(cmd string, args []string) int {
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	host := fs.String("host", "", "服务器地址（必填）")
	port := fs.Int("port", 22, "SSH 端口")
	user := fs.String("user", "root", "SSH 用户")
	keyFile := fs.String("key", "", "SSH 私钥文件")
	proto := fs.String("protocol", "dual", "socks | http | dual | auto")
	socksPort := fs.Int("socks-port", 1080, "SOCKS5 端口（统一端口模式）")
	httpPort := fs.Int("http-port", 8080, "HTTP 端口（统一端口模式）")
	portMode := fs.String("port-mode", "same", "same | inc | random")
	auth := fs.String("auth", "per", "per | shared | custom | none")
	authUser := fs.String("auth-user", "", "自定义用户名（-auth custom）")
	authPassEnv := fs.String("auth-pass-env", "AIO_PROXY_PASSWORD", "自定义代理密码所在的环境变量")
	ips := fs.String("ips", "", "要使用的 IP（逗号分隔），留空则使用所有出口正常的 IPv4")
	dns := fs.String("dns", "recursive", "recursive | forward | public | system")
	speed := fs.Float64("speed", 0, "每账号限速 Mbps，0 不限")
	maxConn := fs.Int("max-conn", 0, "每账号最大并发，0 不限")
	quota := fs.Float64("quota", 0, "每账号每月流量 GB，0 不限")
	noFW := fs.Bool("no-firewall", false, "不修改防火墙")
	noBBR := fs.Bool("no-bbr", false, "不开启 BBR")
	allowPrivate := fs.Bool("allow-private", false, "允许经代理访问内网地址")
	jsonOut := fs.String("json", "", "部署后把代理清单写入该 JSON 文件")
	out := fs.String("out", "", "部署后把 ip:port:user:pass 写入该文件")
	dataDir := fs.String("data", store.Dir(), "本机数据目录")
	viaListen := fs.Bool("via-listen", false, "本机测试直接连接服务器网卡地址（本机与服务器在同一内网时使用）")
	fs.Parse(args)

	if *host == "" {
		fmt.Fprintln(os.Stderr, "缺少 -host")
		return 2
	}
	in := model.ServerInput{Host: *host, Port: *port, User: *user, Password: os.Getenv("AIO_SSH_PASSWORD")}
	if *keyFile != "" {
		b, err := os.ReadFile(*keyFile)
		if err != nil {
			fmt.Fprintln(os.Stderr, "读取私钥失败:", err)
			return 2
		}
		in.AuthType, in.Key, in.Passphrase = "key", string(b), os.Getenv("AIO_SSH_PASSPHRASE")
	}
	st, err := store.New(*dataDir)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	a := app.New(version, st)
	// 命令行模式不写服务器历史
	p := a.Prefs()
	p.SaveHistory = false
	a.SetPrefs(p)

	views, err := a.AddServers([]model.ServerInput{in})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	id := views[0].ID
	ch, unsub := a.Bus.Subscribe()
	defer unsub()

	wait := func(taskID string, err error) error {
		if err != nil {
			return err
		}
		// 事件总线在拥塞时会丢事件，所以任务状态以轮询为准，日志按序号补齐
		printed := 0
		tick := time.NewTicker(300 * time.Millisecond)
		defer tick.Stop()
		flush := func() model.TaskView {
			t, _ := a.Tasks.Get(taskID)
			for ; printed < len(t.Logs); printed++ {
				printLog(&t.Logs[printed])
			}
			return t
		}
		for {
			select {
			case <-ch:
			case <-tick.C:
			}
			t := flush()
			if t.State != "running" && t.ID != "" {
				if t.State != "done" {
					return errors.New(t.Error)
				}
				return nil
			}
		}
	}

	if err := wait(a.Detect(id, false, false)); err != nil {
		fmt.Fprintln(os.Stderr, "探测失败:", err)
		return 1
	}
	switch cmd {
	case "deploy":
		s := a.Prefs().Defaults
		s.Protocol = *proto
		s.Socks = model.PortRule{Mode: *portMode, Port: *socksPort, RangeMin: 20000, RangeMax: 60000}
		s.HTTP = model.PortRule{Mode: *portMode, Port: *httpPort, RangeMin: 20000, RangeMax: 60000}
		s.Auth.Mode = *auth
		if *auth == "custom" {
			s.Auth.User, s.Auth.Pass = *authUser, os.Getenv(*authPassEnv)
		}
		s.DNS.Mode = *dns
		s.Limits = model.Limits{SpeedMbps: *speed, MaxConn: *maxConn, QuotaGB: *quota, QuotaPeriod: "M"}
		s.Firewall, s.BBR, s.BlockPrivate = !*noFW, !*noBBR, !*allowPrivate
		var sel []string
		if *ips != "" {
			sel = strings.Split(*ips, ",")
		}
		if err := wait(a.Deploy(id, model.PlanRequest{Settings: s, Selected: sel}, false)); err != nil {
			fmt.Fprintln(os.Stderr, "部署失败:", err)
			return 1
		}
	case "test":
		if err := wait(a.Test(id, "both", false)); err != nil {
			fmt.Fprintln(os.Stderr, "测试失败:", err)
			return 1
		}
	case "uninstall":
		if err := wait(a.Uninstall(id)); err != nil {
			fmt.Fprintln(os.Stderr, "卸载失败:", err)
			return 1
		}
		return 0
	}

	v, _ := a.View(id)
	if v.Manifest == nil {
		fmt.Fprintln(os.Stderr, "服务器上没有已部署的代理")
		return 1
	}
	failed := 0
	results := map[string]model.TestResult{}
	for _, t := range v.Tests {
		if t.Where == "local" {
			results[t.ProxyID] = t
		}
	}
	if *viaListen {
		var mu sync.Mutex
		tester.TestAll(context.Background(), v.Manifest.Proxies, 32, true, func(r model.TestResult) {
			mu.Lock()
			results[r.ProxyID] = r
			mu.Unlock()
		})
	}
	var lines []string
	fmt.Println()
	for _, p := range v.Manifest.Proxies {
		host := p.Public
		if strings.Contains(host, ":") {
			host = "[" + host + "]"
		}
		line := fmt.Sprintf("%s:%d:%s:%s", host, p.Port, p.User, p.Pass)
		lines = append(lines, line)
		r := results[p.ID]
		mark := "✓"
		if !r.OK {
			mark, failed = "✗ "+r.Error, failed+1
		}
		fmt.Printf("%-6s %s  %s\n", strings.ToUpper(p.Protocol), line, mark)
	}
	if *out != "" {
		os.WriteFile(*out, []byte(strings.Join(lines, "\n")+"\n"), 0o600)
	}
	if *jsonOut != "" {
		b, _ := json.MarshalIndent(v, "", "  ")
		os.WriteFile(*jsonOut, b, 0o600)
	}
	if failed > 0 {
		fmt.Fprintf(os.Stderr, "\n%d 个代理本机测试未通过\n", failed)
		return 3
	}
	return 0
}

func printLog(l *model.LogLine) {
	prefix := map[string]string{"step": "==>", "ok": " ✓ ", "warn": " ! ", "error": " ✗ "}[l.Level]
	if prefix == "" {
		prefix = "   "
	}
	fmt.Printf("%s %s %s\n", l.T.Format(time.TimeOnly), prefix, l.Text)
}
