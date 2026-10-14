package sshx

import (
	"context"
	"net"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// 对方接受 TCP 连接但从不发送 SSH 标识时，连接必须按超时返回，而不是永远卡住
func TestDialHandshakeTimeout(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			defer c.Close() // 不读不写，保持连接
		}
	}()
	host, port, _ := net.SplitHostPort(ln.Addr().String())
	p, _ := strconv.Atoi(port)
	kh := NewKnownHosts(filepath.Join(t.TempDir(), "known_hosts"))

	start := time.Now()
	_, err = Dial(context.Background(), Config{Host: host, Port: p, User: "root", Password: "x", Timeout: time.Second}, kh)
	if err == nil {
		t.Fatal("应当失败")
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("握手超时没有生效，用了 %v", d)
	}

	// 取消也要能立即中断握手
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(300*time.Millisecond, cancel)
	start = time.Now()
	_, err = Dial(ctx, Config{Host: host, Port: p, User: "root", Password: "x", Timeout: time.Minute}, kh)
	if err == nil || time.Since(start) > 5*time.Second {
		t.Fatalf("取消没有中断握手: %v，用了 %v", err, time.Since(start))
	}
}
