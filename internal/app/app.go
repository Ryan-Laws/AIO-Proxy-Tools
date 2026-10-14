// Package app 是业务编排层：管理服务器、凭据与连接，执行探测、部署、测试等任务。
package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/model"
	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/plan"
	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/release"
	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/sshx"
	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/store"
	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/task"
)

// Server 是内存中的一台服务器。
type Server struct {
	mu     sync.Mutex
	view   model.ServerView
	secret store.Secret
	client *sshx.Client
	// adminPort 在首次部署前预先选定，保证预览和部署一致
	adminPort int
	busy      bool
	// lastPlan 缓存最近一次预览：用相同设置部署时沿用，保证随机账号与预览一致
	lastPlanKey string
	lastPlan    model.PlanResult
}

type App struct {
	Version string
	Store   *store.Store
	KH      *sshx.KnownHosts
	Bus     *task.Bus
	Tasks   *task.Manager
	Fetcher *release.Fetcher

	mu      sync.Mutex
	servers map[string]*Server
	order   []string
	prefs   model.Preferences
	batch   chan struct{}
}

func New(version string, st *store.Store) *App {
	bus := task.NewBus()
	a := &App{
		Version: version,
		Store:   st,
		KH:      sshx.NewKnownHosts(st.Path("known_hosts")),
		Bus:     bus,
		Tasks:   task.NewManager(bus),
		Fetcher: &release.Fetcher{CacheDir: st.Path("cache")},
		servers: map[string]*Server{},
	}
	a.prefs = st.LoadPrefs(model.Preferences{SaveHistory: true, Concurrency: 3, Defaults: plan.Defaults(), Theme: "system"})
	a.batch = make(chan struct{}, a.prefs.Concurrency)
	if a.prefs.SaveHistory {
		for _, s := range st.LoadServers() {
			srv := &Server{view: model.ServerView{
				ID: s.ID, Name: s.Name, Host: s.Host, Port: s.Port, User: s.User, AuthType: s.AuthType,
				Remember: s.Remember, Selected: s.Selected, State: "new", UpdatedAt: time.Now(),
			}}
			a.servers[s.ID] = srv
			a.order = append(a.order, s.ID)
		}
	}
	return a
}

func newID(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// ---------- 偏好 ----------

func (a *App) Prefs() model.Preferences {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.prefs
}

func (a *App) SetPrefs(p model.Preferences) (model.Preferences, error) {
	if p.Concurrency < 1 || p.Concurrency > 10 {
		p.Concurrency = 3
	}
	a.mu.Lock()
	old := a.prefs
	a.prefs = p
	if old.Concurrency != p.Concurrency {
		a.batch = make(chan struct{}, p.Concurrency)
	}
	a.mu.Unlock()
	if err := a.Store.SavePrefs(p); err != nil {
		return p, err
	}
	if !p.SaveHistory {
		a.Store.ClearServers()
	} else {
		a.persist()
	}
	return p, nil
}

// ---------- 服务器列表 ----------

func (a *App) get(id string) (*Server, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	s, ok := a.servers[id]
	if !ok {
		return nil, errors.New("服务器不存在")
	}
	return s, nil
}

func (s *Server) snapshot() model.ServerView {
	v := s.view
	v.HasSecret = s.secret.Password != "" || s.secret.Key != ""
	return v
}

func (a *App) publish(s *Server) {
	s.mu.Lock()
	v := s.snapshot()
	s.mu.Unlock()
	a.Bus.Publish(model.Event{Type: "server", Server: &v})
}

// update 在锁内修改服务器状态并推送。
func (a *App) update(s *Server, fn func(v *model.ServerView)) {
	s.mu.Lock()
	fn(&s.view)
	s.view.UpdatedAt = time.Now()
	s.mu.Unlock()
	a.publish(s)
}

func (a *App) List() []model.ServerView {
	a.mu.Lock()
	ids := append([]string(nil), a.order...)
	a.mu.Unlock()
	out := make([]model.ServerView, 0, len(ids))
	for _, id := range ids {
		if s, err := a.get(id); err == nil {
			s.mu.Lock()
			out = append(out, s.snapshot())
			s.mu.Unlock()
		}
	}
	return out
}

func (a *App) View(id string) (model.ServerView, error) {
	s, err := a.get(id)
	if err != nil {
		return model.ServerView{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.snapshot(), nil
}

func (a *App) persist() {
	a.mu.Lock()
	save := a.prefs.SaveHistory
	ids := append([]string(nil), a.order...)
	a.mu.Unlock()
	if !save {
		return
	}
	var list []store.SavedServer
	for _, id := range ids {
		s, err := a.get(id)
		if err != nil {
			continue
		}
		s.mu.Lock()
		v := s.view
		s.mu.Unlock()
		list = append(list, store.SavedServer{ID: v.ID, Name: v.Name, Host: v.Host, Port: v.Port, User: v.User,
			AuthType: v.AuthType, Remember: v.Remember, Selected: v.Selected})
	}
	a.Store.SaveServers(list)
}

func normalizeInput(in *model.ServerInput) error {
	in.Host = strings.TrimSpace(in.Host)
	in.User = strings.TrimSpace(in.User)
	in.Name = strings.TrimSpace(in.Name)
	if h, p, err := net.SplitHostPort(in.Host); err == nil && in.Port == 0 {
		in.Host = h
		in.Port, _ = strconv.Atoi(p)
	}
	in.Host = strings.Trim(in.Host, "[]")
	if in.Host == "" {
		return errors.New("主机地址不能为空")
	}
	if in.Port == 0 {
		in.Port = 22
	}
	if in.Port < 1 || in.Port > 65535 {
		return fmt.Errorf("SSH 端口 %d 无效", in.Port)
	}
	if in.User == "" {
		in.User = "root"
	}
	if in.AuthType != "key" {
		in.AuthType = "password"
	}
	return nil
}

func (a *App) AddServers(inputs []model.ServerInput) ([]model.ServerView, error) {
	for i := range inputs {
		if err := normalizeInput(&inputs[i]); err != nil {
			return nil, fmt.Errorf("第 %d 台: %v", i+1, err)
		}
		if inputs[i].Remember && !a.Store.VaultUnlocked() {
			return nil, errors.New("要记住密码，请先创建或解锁保险箱")
		}
	}
	var out []model.ServerView
	for _, in := range inputs {
		s := &Server{
			view: model.ServerView{ID: newID(6), Name: in.Name, Host: in.Host, Port: in.Port, User: in.User,
				AuthType: in.AuthType, Remember: in.Remember, State: "new", UpdatedAt: time.Now()},
			secret: store.Secret{Password: in.Password, Key: in.Key, Passphrase: in.Passphrase},
		}
		if in.Remember {
			sec := s.secret
			a.Store.PutSecret(s.view.ID, &sec)
		}
		a.mu.Lock()
		a.servers[s.view.ID] = s
		a.order = append(a.order, s.view.ID)
		a.mu.Unlock()
		a.publish(s)
		out = append(out, s.snapshot())
	}
	a.persist()
	return out, nil
}

func (a *App) UpdateServer(id string, in model.ServerInput) (model.ServerView, error) {
	s, err := a.get(id)
	if err != nil {
		return model.ServerView{}, err
	}
	if err := normalizeInput(&in); err != nil {
		return model.ServerView{}, err
	}
	if in.Remember && !a.Store.VaultUnlocked() {
		return model.ServerView{}, errors.New("要记住密码，请先创建或解锁保险箱")
	}
	s.mu.Lock()
	changedHost := s.view.Host != in.Host || s.view.Port != in.Port || s.view.User != in.User
	s.view.Name, s.view.Host, s.view.Port, s.view.User, s.view.AuthType, s.view.Remember = in.Name, in.Host, in.Port, in.User, in.AuthType, in.Remember
	if in.AuthType == "password" {
		if in.Password != "" {
			s.secret = store.Secret{Password: in.Password}
		}
	} else if in.Key != "" {
		s.secret = store.Secret{Key: in.Key, Passphrase: in.Passphrase, Password: in.Password}
	}
	if changedHost || in.Password != "" || in.Key != "" {
		if s.client != nil {
			s.client.Close()
			s.client = nil
		}
	}
	sec := s.secret
	s.mu.Unlock()
	if a.Store.VaultUnlocked() {
		if in.Remember {
			a.Store.PutSecret(id, &sec)
		} else {
			a.Store.PutSecret(id, nil)
		}
	}
	a.publish(s)
	a.persist()
	return a.View(id)
}

func (a *App) RemoveServer(id string) error {
	s, err := a.get(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	if s.client != nil {
		s.client.Close()
	}
	s.mu.Unlock()
	a.mu.Lock()
	delete(a.servers, id)
	for i, x := range a.order {
		if x == id {
			a.order = append(a.order[:i], a.order[i+1:]...)
			break
		}
	}
	a.mu.Unlock()
	if a.Store.VaultUnlocked() {
		a.Store.PutSecret(id, nil)
	}
	a.Bus.Publish(model.Event{Type: "server-removed", ID: id})
	a.persist()
	return nil
}

func (a *App) SetSelected(id string, sel []string) (model.ServerView, error) {
	s, err := a.get(id)
	if err != nil {
		return model.ServerView{}, err
	}
	a.update(s, func(v *model.ServerView) { v.Selected = dedupe(sel) })
	a.persist()
	return a.View(id)
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, x := range in {
		x = strings.TrimSpace(x)
		if x != "" && !seen[x] {
			seen[x] = true
			out = append(out, x)
		}
	}
	return out
}

// ---------- 保险箱 ----------

func (a *App) VaultState() map[string]bool {
	return map[string]bool{"exists": a.Store.VaultExists(), "unlocked": a.Store.VaultUnlocked()}
}

func (a *App) CreateVault(pw string) error {
	if err := a.Store.CreateVault(pw); err != nil {
		return err
	}
	// 把已勾选"记住"的服务器凭据写入
	for _, v := range a.List() {
		if s, err := a.get(v.ID); err == nil && v.Remember {
			s.mu.Lock()
			sec := s.secret
			s.mu.Unlock()
			a.Store.PutSecret(v.ID, &sec)
		}
	}
	return nil
}

func (a *App) UnlockVault(pw string) error {
	m, err := a.Store.UnlockVault(pw)
	if err != nil {
		return err
	}
	for id, sec := range m {
		if s, err := a.get(id); err == nil {
			s.mu.Lock()
			if s.secret.Password == "" && s.secret.Key == "" {
				s.secret = sec
			}
			s.mu.Unlock()
			a.publish(s)
		}
	}
	return nil
}

// ---------- 批量粘贴解析 ----------

// ParseBatch 解析每行 "host[:port] [user] [password]"，也接受 CSV（逗号分隔）。
func ParseBatch(text string, defPort int, defUser, authType string) ([]model.ServerInput, []string) {
	var out []model.ServerInput
	var errs []string
	if defPort == 0 {
		defPort = 22
	}
	if defUser == "" {
		defUser = "root"
	}
	for i, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(strings.TrimPrefix(raw, "\uFEFF"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		var f []string
		if strings.Contains(line, ",") {
			for _, x := range strings.Split(line, ",") {
				f = append(f, strings.TrimSpace(x))
			}
			if strings.EqualFold(f[0], "host") {
				continue // CSV 表头
			}
		} else {
			f = strings.Fields(line)
		}
		in := model.ServerInput{Port: defPort, User: defUser, AuthType: authType}
		host := f[0]
		if h, p, err := net.SplitHostPort(host); err == nil {
			host = h
			in.Port, _ = strconv.Atoi(p)
		}
		in.Host = host
		rest := f[1:]
		// CSV: host,port,user,password
		if len(rest) > 0 && strings.Contains(line, ",") {
			if p, err := strconv.Atoi(rest[0]); err == nil {
				in.Port = p
				rest = rest[1:]
			} else if rest[0] == "" {
				rest = rest[1:]
			}
		}
		if len(rest) > 0 && rest[0] != "" {
			in.User = rest[0]
		}
		if len(rest) > 1 {
			in.Password = strings.Join(rest[1:], " ")
			if strings.Contains(line, ",") {
				in.Password = rest[1]
			}
		}
		if err := normalizeInput(&in); err != nil {
			errs = append(errs, fmt.Sprintf("第 %d 行: %v", i+1, err))
			continue
		}
		out = append(out, in)
	}
	return out, errs
}

// ---------- 连接 ----------

func (a *App) client(ctx context.Context, s *Server, trustNew bool) (*sshx.Client, error) {
	s.mu.Lock()
	c := s.client
	sec := s.secret
	cfg := sshx.Config{Host: s.view.Host, Port: s.view.Port, User: s.view.User,
		Password: sec.Password, Key: sec.Key, Passphrase: sec.Passphrase, TrustNewKey: trustNew}
	s.mu.Unlock()
	if c != nil && !trustNew && c.Alive() {
		return c, nil
	}
	if sec.Password == "" && sec.Key == "" {
		if a.Store.VaultExists() && !a.Store.VaultUnlocked() {
			return nil, errors.New("凭据保存在保险箱中，请先解锁保险箱")
		}
		return nil, errors.New("缺少 SSH 密码或私钥，请编辑服务器填写")
	}
	nc, err := sshx.Dial(ctx, cfg, a.KH)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	if s.client != nil {
		s.client.Close()
	}
	s.client = nc
	s.view.Fingerprint = nc.Fingerprint
	s.mu.Unlock()
	return nc, nil
}

// run 以任务形式执行一个针对服务器的操作；同一台服务器同时只允许一个任务。
func (a *App) run(id, kind string, batch bool, fn func(ctx context.Context, t *task.Task, s *Server) error) (string, error) {
	s, err := a.get(id)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	if s.busy {
		s.mu.Unlock()
		return "", errors.New("该服务器正在执行其它任务，请稍候")
	}
	s.busy = true
	s.mu.Unlock()
	t := a.Tasks.Start(id, kind, func(ctx context.Context, t *task.Task) error {
		// 在任务协程内设置，保证先于 onEnd 的清除执行
		a.update(s, func(v *model.ServerView) { v.TaskID = t.ID() })
		if batch {
			a.mu.Lock()
			sem := a.batch
			a.mu.Unlock()
			t.Step("排队等待（批量并发限制）")
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		return fn(ctx, t, s)
	}, func(t *task.Task, err error) {
		s.mu.Lock()
		s.busy = false
		if s.view.TaskID == t.ID() {
			s.view.TaskID = ""
		}
		s.mu.Unlock()
		a.publish(s)
	})
	return t.ID(), nil
}

func sortedKeys(m map[string]bool) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
