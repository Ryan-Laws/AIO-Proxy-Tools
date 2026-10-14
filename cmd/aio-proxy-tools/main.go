// AIO Proxy Tools：把一台 VPS 上的每个 IP 一键部署成独立的 SOCKS5 / HTTP 代理。
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"syscall"
	"time"

	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/app"
	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/store"
	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/web"
	webui "github.com/Ryan-Laws/AIO-Proxy-Tools/web"
)

// version 在发布构建时通过 -ldflags "-X main.version=..." 注入。
var version = "dev"

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "deploy", "test", "uninstall":
			os.Exit(runCLI(os.Args[1], os.Args[2:]))
		}
	}
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, `用法:
  %[1]s [选项]                 启动图形界面（默认）
  %[1]s deploy -host IP [选项]  命令行部署（-h 查看选项）
  %[1]s test -host IP           测试已部署的代理
  %[1]s uninstall -host IP      卸载

界面选项:
`, filepath.Base(os.Args[0]))
		flag.PrintDefaults()
	}
	listen := flag.String("listen", "127.0.0.1:0", "本地界面监听地址")
	noBrowser := flag.Bool("no-browser", false, "不自动打开浏览器")
	dataDir := flag.String("data", store.Dir(), "本机数据目录")
	dev := flag.Bool("dev", false, "开发模式：固定端口 17890、固定令牌 dev，供 Vite 开发服务器代理")
	showVersion := flag.Bool("version", false, "显示版本")
	flag.Parse()
	if *showVersion {
		fmt.Println("AIO Proxy Tools", version)
		return
	}

	st, err := store.New(*dataDir)
	if err != nil {
		fatal("无法创建数据目录: %v", err)
	}
	a := app.New(version, st)

	token := randToken()
	addr := *listen
	if *dev {
		token, addr = "dev", "127.0.0.1:17890"
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		fatal("监听地址无效: %v", err)
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		fmt.Println("⚠ 警告：界面监听在非本机地址，任何能访问该地址并知道令牌的人都能操作你的服务器。")
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		fatal("无法监听 %s: %v", addr, err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	allow := map[string]bool{host: true}
	srv := &http.Server{
		Handler:           (&web.Server{App: a, Token: token, UI: webui.FS(), AllowHosts: allow}).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	showHost := host
	if host == "0.0.0.0" || host == "::" || host == "" {
		showHost = "127.0.0.1"
	}
	url := "http://" + net.JoinHostPort(showHost, strconv.Itoa(port)) + "/?t=" + token

	fmt.Println("AIO Proxy Tools", version)
	fmt.Println("界面地址:", url)
	fmt.Println("数据目录:", *dataDir)
	fmt.Println("关闭此窗口或按 Ctrl+C 退出。")
	if !*noBrowser && !*dev {
		go func() {
			time.Sleep(300 * time.Millisecond)
			if err := openBrowser(url); err != nil {
				fmt.Println("无法自动打开浏览器，请手动复制上面的地址到浏览器。")
			}
		}()
	}

	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			fatal("服务异常: %v", err)
		}
	}()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
}

func randToken() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func openBrowser(url string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case "darwin":
		return exec.Command("open", url).Start()
	default:
		if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
			return errors.New("no display")
		}
		return exec.Command("xdg-open", url).Start()
	}
}

func fatal(f string, a ...any) {
	fmt.Fprintf(os.Stderr, "错误: "+f+"\n", a...)
	if runtime.GOOS == "windows" {
		fmt.Fprintln(os.Stderr, "按回车键退出…")
		fmt.Scanln()
	}
	os.Exit(1)
}
