// Package sshx 封装 SSH 连接、sudo 提权、文件上传与脚本执行。
package sshx

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// Config 是一次连接所需的全部信息。
type Config struct {
	Host       string
	Port       int
	User       string
	Password   string
	Key        string // PEM 私钥内容
	Passphrase string
	// TrustNewKey 为 true 时，主机密钥与记录不一致也接受并更新记录。
	TrustNewKey bool
	Timeout     time.Duration
}

// Client 是一个已建立的 SSH 连接。
type Client struct {
	cfg         Config
	conn        *ssh.Client
	isRoot      bool
	sudoNeedPwd bool
	Fingerprint string
	mu          sync.Mutex
}

// HostKeyError 表示主机密钥与之前记录的不一致。
type HostKeyError struct {
	Host     string
	Got      string
	Expected []string
}

func (e *HostKeyError) Error() string {
	return fmt.Sprintf("主机密钥已改变（当前 %s）。如果你重装过系统，这是正常的，可以选择“信任新密钥”；否则可能存在中间人攻击", e.Got)
}

// Dial 建立连接并确定提权方式。
func Dial(ctx context.Context, cfg Config, kh *KnownHosts) (*Client, error) {
	if cfg.Port == 0 {
		cfg.Port = 22
	}
	if cfg.User == "" {
		cfg.User = "root"
	}
	if cfg.Timeout == 0 {
		cfg.Timeout = 20 * time.Second
	}
	var auths []ssh.AuthMethod
	if strings.TrimSpace(cfg.Key) != "" {
		var signer ssh.Signer
		var err error
		if cfg.Passphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(cfg.Key), []byte(cfg.Passphrase))
		} else {
			signer, err = ssh.ParsePrivateKey([]byte(cfg.Key))
		}
		if err != nil {
			var pme *ssh.PassphraseMissingError
			if errors.As(err, &pme) {
				return nil, errors.New("私钥已加密，请填写私钥口令")
			}
			return nil, fmt.Errorf("私钥无效: %v", err)
		}
		auths = append(auths, ssh.PublicKeys(signer))
	}
	if cfg.Password != "" {
		pw := cfg.Password
		auths = append(auths, ssh.Password(pw),
			ssh.KeyboardInteractive(func(_, _ string, qs []string, _ []bool) ([]string, error) {
				ans := make([]string, len(qs))
				for i := range qs {
					ans[i] = pw
				}
				return ans, nil
			}))
	}
	if len(auths) == 0 {
		return nil, errors.New("缺少登录凭据（密码或私钥）")
	}

	c := &Client{cfg: cfg}
	var hkErr error
	addr := net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
	sc := &ssh.ClientConfig{
		User:    cfg.User,
		Auth:    auths,
		Timeout: cfg.Timeout,
		HostKeyCallback: func(hostname string, remote net.Addr, key ssh.PublicKey) error {
			c.Fingerprint = ssh.FingerprintSHA256(key)
			hkErr = kh.Check(addr, key, cfg.TrustNewKey)
			return hkErr
		},
	}
	d := net.Dialer{Timeout: cfg.Timeout}
	raw, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("无法连接 %s: %v", addr, friendlyNetErr(err))
	}
	sconn, chans, reqs, err := ssh.NewClientConn(raw, addr, sc)
	if err != nil {
		raw.Close()
		var hke *HostKeyError
		if errors.As(hkErr, &hke) {
			return nil, hke
		}
		if hkErr != nil {
			return nil, fmt.Errorf("主机密钥校验失败: %v", hkErr)
		}
		if strings.Contains(err.Error(), "unable to authenticate") {
			return nil, errors.New("SSH 认证失败：用户名、密码或私钥不正确")
		}
		return nil, fmt.Errorf("SSH 握手失败: %v", err)
	}
	c.conn = ssh.NewClient(sconn, chans, reqs)
	go keepalive(c.conn)

	out, _, err := c.Output(ctx, "id -u", nil)
	if err != nil {
		c.Close()
		return nil, fmt.Errorf("执行命令失败: %v", err)
	}
	c.isRoot = strings.TrimSpace(out) == "0"
	if !c.isRoot {
		if _, code, _ := c.Output(ctx, "sudo -n true", nil); code != 0 {
			if cfg.Password == "" {
				c.Close()
				return nil, errors.New("当前用户不是 root，且 sudo 需要密码：请改用 root 登录，或填写该用户的密码")
			}
			c.sudoNeedPwd = true
			_, code, _ := c.Output(ctx, "sudo -S -p '' true", strings.NewReader(cfg.Password+"\n"))
			if code != 0 {
				c.Close()
				return nil, errors.New("当前用户不是 root，且无法使用 sudo 提权")
			}
		}
	}
	return c, nil
}

func keepalive(c *ssh.Client) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for range t.C {
		if _, _, err := c.SendRequest("keepalive@openssh.com", true, nil); err != nil {
			return
		}
	}
}

func friendlyNetErr(err error) string {
	s := err.Error()
	switch {
	case strings.Contains(s, "timeout") || strings.Contains(s, "i/o timeout"):
		return "连接超时（检查 IP、端口和安全组）"
	case strings.Contains(s, "refused"):
		return "连接被拒绝（SSH 端口不对或 sshd 未运行）"
	case strings.Contains(s, "no such host"):
		return "域名无法解析"
	}
	return s
}

func (c *Client) Close() error {
	if c.conn == nil {
		return nil
	}
	return c.conn.Close()
}

// Alive 检查连接是否仍可用。
func (c *Client) Alive() bool {
	if c.conn == nil {
		return false
	}
	_, _, err := c.conn.SendRequest("keepalive@openssh.com", true, nil)
	return err == nil
}

func (c *Client) IsRoot() bool { return c.isRoot }

// Output 执行命令并返回合并后的输出与退出码。
func (c *Client) Output(ctx context.Context, cmd string, stdin io.Reader) (string, int, error) {
	var buf bytes.Buffer
	code, err := c.run(ctx, cmd, stdin, func(line string) {
		buf.WriteString(line)
		buf.WriteByte('\n')
	})
	return buf.String(), code, err
}

// run 执行命令，按行回调 stdout/stderr。ctx 取消时关闭会话。
func (c *Client) run(ctx context.Context, cmd string, stdin io.Reader, onLine func(string)) (int, error) {
	sess, err := c.conn.NewSession()
	if err != nil {
		return -1, fmt.Errorf("SSH 会话创建失败: %v", err)
	}
	defer sess.Close()
	if stdin != nil {
		sess.Stdin = stdin
	}
	pr, pw := io.Pipe()
	sess.Stdout = pw
	sess.Stderr = pw
	var mu sync.Mutex
	done := make(chan struct{})
	go func() {
		defer close(done)
		sc := bufio.NewScanner(pr)
		sc.Buffer(make([]byte, 64*1024), 8*1024*1024)
		for sc.Scan() {
			mu.Lock()
			onLine(stripANSI(sc.Text()))
			mu.Unlock()
		}
		io.Copy(io.Discard, pr)
	}()
	if err := sess.Start(cmd); err != nil {
		pw.Close()
		<-done
		return -1, err
	}
	waitErr := make(chan error, 1)
	go func() { waitErr <- sess.Wait() }()
	var werr error
	select {
	case werr = <-waitErr:
	case <-ctx.Done():
		sess.Signal(ssh.SIGTERM)
		sess.Close()
		werr = ctx.Err()
	}
	pw.Close()
	<-done
	if werr == nil {
		return 0, nil
	}
	var ee *ssh.ExitError
	if errors.As(werr, &ee) {
		return ee.ExitStatus(), nil
	}
	if errors.Is(werr, context.Canceled) || errors.Is(werr, context.DeadlineExceeded) {
		return -1, werr
	}
	var em *ssh.ExitMissingError
	if errors.As(werr, &em) {
		return -1, errors.New("SSH 连接中断")
	}
	return -1, werr
}

var ansiRe = regexp.MustCompile(`\x1b\[[0-9;]*[A-Za-z]`)

func stripANSI(s string) string { return ansiRe.ReplaceAllString(s, "") }

// Script 描述一次远程脚本执行。
type Script struct {
	Body   string            // 主脚本内容
	Files  map[string][]byte // 同目录下的附加文件（可含子目录，如 assets/x）
	Env    map[string]string
	OnLine func(string)
}

// RunScript 上传脚本与文件到临时目录，以 root 身份执行，结束后删除临时目录。
func (c *Client) RunScript(ctx context.Context, s Script) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	out, code, err := c.Output(ctx, "umask 077; mktemp -d /tmp/aio-proxy.XXXXXX", nil)
	if err != nil || code != 0 {
		return -1, fmt.Errorf("创建临时目录失败: %v %s", err, out)
	}
	dir := strings.TrimSpace(out)
	if !strings.HasPrefix(dir, "/tmp/aio-proxy.") {
		return -1, fmt.Errorf("临时目录异常: %q", dir)
	}
	cleanup := func() {
		cctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		c.Output(cctx, c.asRoot("rm -rf "+shellQuote(dir)), c.sudoStdin())
	}
	defer cleanup()

	files := map[string][]byte{"main.sh": []byte(s.Body)}
	for k, v := range s.Files {
		files[k] = v
	}
	names := make([]string, 0, len(files))
	for k := range files {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, name := range names {
		if strings.Contains(name, "..") || strings.HasPrefix(name, "/") {
			return -1, fmt.Errorf("非法文件名 %q", name)
		}
		p := dir + "/" + name
		cmd := fmt.Sprintf("mkdir -p %s && cat > %s", shellQuote(path.Dir(p)), shellQuote(p))
		if o, code, err := c.Output(ctx, cmd, bytes.NewReader(files[name])); err != nil || code != 0 {
			return -1, fmt.Errorf("上传 %s 失败: %v %s", name, err, o)
		}
	}

	var env strings.Builder
	keys := make([]string, 0, len(s.Env))
	for k := range s.Env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		env.WriteString(k + "=" + shellQuote(s.Env[k]) + " ")
	}
	cmd := c.asRoot("env " + env.String() + "sh " + shellQuote(dir+"/main.sh"))
	onLine := s.OnLine
	if onLine == nil {
		onLine = func(string) {}
	}
	return c.run(ctx, cmd, c.sudoStdin(), onLine)
}

func (c *Client) asRoot(cmd string) string {
	if c.isRoot {
		return cmd
	}
	if c.sudoNeedPwd {
		return "sudo -S -p '' " + cmd
	}
	return "sudo -n " + cmd
}

func (c *Client) sudoStdin() io.Reader {
	if !c.isRoot && c.sudoNeedPwd {
		return strings.NewReader(c.cfg.Password + "\n")
	}
	return nil
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
