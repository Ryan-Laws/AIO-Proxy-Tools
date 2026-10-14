// Package tester 从本机直连测试已部署的代理（不经过本机的系统代理）。
package tester

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/proxy"

	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/model"
	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/netx"
)

var echo4 = []string{"https://api.ipify.org", "https://ipv4.icanhazip.com", "https://ifconfig.me/ip"}
var echo6 = []string{"https://api64.ipify.org", "https://ipv6.icanhazip.com", "https://ifconfig.co/ip"}

// Test 测试单个代理：连通性、出口 IP、以及不带密码是否被拒绝。
func Test(ctx context.Context, p model.Proxy) model.TestResult {
	return TestVia(ctx, p, false)
}

// TestVia 与 Test 相同；viaListen 为 true 时直接连接服务器网卡地址（本机与服务器同处内网时）。
func TestVia(ctx context.Context, p model.Proxy, viaListen bool) model.TestResult {
	r := model.TestResult{ProxyID: p.ID, Where: "local", Expected: p.Public}
	host := p.Public
	if host == "" || viaListen {
		host = p.Listen
	}
	addr := net.JoinHostPort(host, strconv.Itoa(p.Port))
	var cred *url.Userinfo
	if p.User != "" {
		cred = url.UserPassword(p.User, p.Pass)
	}
	urls := echo4
	if p.Family == 6 {
		urls = echo6
	}
	start := time.Now()
	var lastErr error
	for _, u := range urls {
		t0 := time.Now()
		body, err := fetch(ctx, p.Protocol, addr, cred, u)
		if err != nil {
			lastErr = err
			if isAuthOrConnErr(err, addr) {
				break
			}
			continue
		}
		ip := netx.Canon(strings.TrimSpace(body))
		if ip == "" {
			lastErr = errors.New("回显服务返回了无效内容")
			continue
		}
		r.OK = true
		r.Egress = ip
		r.LatencyMs = int(time.Since(t0).Milliseconds())
		break
	}
	if !r.OK {
		r.Error = explain(lastErr, addr)
		r.LatencyMs = int(time.Since(start).Milliseconds())
		return r
	}
	if p.Public != "" && r.Egress != p.Public {
		r.Error = fmt.Sprintf("出口 IP 为 %s，与预期 %s 不一致", r.Egress, p.Public)
	}
	if p.User != "" {
		_, err := fetch(ctx, p.Protocol, addr, nil, urls[0])
		var ae authErr
		switch {
		case err == nil:
			denied := false
			r.AuthOK = &denied
			r.Error = "不带密码也能使用，认证未生效！"
			r.OK = false
		case errors.As(err, &ae):
			denied := true
			r.AuthOK = &denied
		default:
			// 超时、回显服务不可用等：无法判断认证是否生效，不下结论（AuthOK 留空）
		}
	}
	return r
}

// TestAll 并发测试，每完成一个回调一次。
func TestAll(ctx context.Context, ps []model.Proxy, concurrency int, viaListen bool, onDone func(model.TestResult)) {
	if concurrency <= 0 {
		concurrency = 32
	}
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	for _, p := range ps {
		select {
		case <-ctx.Done():
			wg.Wait()
			return
		case sem <- struct{}{}:
		}
		wg.Add(1)
		go func(p model.Proxy) {
			defer wg.Done()
			defer func() { <-sem }()
			c, cancel := context.WithTimeout(ctx, 25*time.Second)
			defer cancel()
			onDone(TestVia(c, p, viaListen))
		}(p)
	}
	wg.Wait()
}

type authErr struct{ msg string }

func (e authErr) Error() string { return e.msg }

func fetch(ctx context.Context, proto, addr string, cred *url.Userinfo, target string) (string, error) {
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	tr := &http.Transport{
		Proxy:                 nil, // 必须直连代理，不能经过本机系统代理
		DisableKeepAlives:     true,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 12 * time.Second,
	}
	switch proto {
	case "http":
		pu := &url.URL{Scheme: "http", Host: addr, User: cred}
		tr.Proxy = http.ProxyURL(pu)
		tr.DialContext = dialer.DialContext
	default: // socks / auto
		var auth *proxy.Auth
		if cred != nil {
			pw, _ := cred.Password()
			auth = &proxy.Auth{User: cred.Username(), Password: pw}
		}
		d, err := proxy.SOCKS5("tcp", addr, auth, dialer)
		if err != nil {
			return "", err
		}
		cd, ok := d.(proxy.ContextDialer)
		if !ok {
			return "", errors.New("SOCKS5 拨号器不支持 context")
		}
		tr.DialContext = cd.DialContext
	}
	defer tr.CloseIdleConnections()
	cl := &http.Client{Transport: tr, Timeout: 20 * time.Second}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "curl/8.0")
	resp, err := cl.Do(req)
	if err != nil {
		s := err.Error()
		if strings.Contains(s, "407") || strings.Contains(s, "Proxy Authentication Required") ||
			strings.Contains(s, "authentication failed") || strings.Contains(s, "not allowed by ruleset") ||
			strings.Contains(s, "no acceptable authentication methods") {
			return "", authErr{"认证被拒绝"}
		}
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusProxyAuthRequired {
		return "", authErr{"认证被拒绝（407）"}
	}
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 256))
	return string(b), err
}

// isAuthOrConnErr 判断是否为"连不上代理/认证失败"——这类错误换回显服务也没用。
// 注意区分：代理已连上、但代理去连目标失败时，错误里不含本机 "dial tcp"。
func isAuthOrConnErr(err error, addr string) bool {
	var ae authErr
	if errors.As(err, &ae) {
		return true
	}
	return proxyUnreachable(err.Error(), addr)
}

// proxyUnreachable：错误发生在"本机连代理"这一步（而不是代理连目标）。
func proxyUnreachable(s, addr string) bool {
	return strings.Contains(s, "proxyconnect") || strings.Contains(s, "dial tcp "+addr)
}

func explain(err error, addr string) string {
	if err == nil {
		return "未知错误"
	}
	var ae authErr
	if errors.As(err, &ae) {
		return ae.msg
	}
	s := err.Error()
	unreachable := proxyUnreachable(s, addr)
	switch {
	case unreachable && strings.Contains(s, "refused") || strings.Contains(s, "actively refused"):
		return "连接被拒绝（端口未监听或被防火墙拒绝）"
	case unreachable && (strings.Contains(s, "timeout") || strings.Contains(s, "deadline") || strings.Contains(s, "failed to respond")):
		return "连接超时（大概率是云厂商安全组未放行端口）"
	case strings.Contains(s, "refused"):
		return "代理已连通，但访问测试站点被拒绝"
	case strings.Contains(s, "timeout") || strings.Contains(s, "deadline"):
		return "请求超时"
	case strings.Contains(s, "EOF") || strings.Contains(s, "reset"):
		return "连接被中断"
	}
	return s
}
