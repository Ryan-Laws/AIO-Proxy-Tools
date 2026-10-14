// Package web 提供本地 HTTP API、SSE 事件流与内嵌前端页面。
package web

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/app"
	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/model"
	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/plan"
)

type Server struct {
	App   *app.App
	Token string
	UI    fs.FS // 前端静态文件（web/dist）
	// AllowHosts 是允许的 Host 头（防 DNS 重绑定），为空时只允许回环地址。
	AllowHosts map[string]bool
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	api := func(pattern string, h func(w http.ResponseWriter, r *http.Request) (any, error)) {
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			v, err := h(w, r)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			if v == nil {
				v = map[string]any{}
			}
			writeJSON(w, http.StatusOK, v)
		})
	}
	a := s.App

	api("GET /api/meta", func(w http.ResponseWriter, r *http.Request) (any, error) {
		return map[string]any{"version": a.Version, "vault": a.VaultState(), "defaults": plan.Defaults(), "prefs": a.Prefs()}, nil
	})
	api("PUT /api/prefs", func(w http.ResponseWriter, r *http.Request) (any, error) {
		var p model.Preferences
		if err := decode(r, &p); err != nil {
			return nil, err
		}
		return a.SetPrefs(p)
	})

	// 保险箱
	type pwReq struct {
		Password string `json:"password"`
	}
	api("POST /api/vault/create", func(w http.ResponseWriter, r *http.Request) (any, error) {
		var q pwReq
		if err := decode(r, &q); err != nil {
			return nil, err
		}
		// 先创建再取状态（Go 从左到右求值，写成一行会返回创建前的状态）
		if err := a.CreateVault(q.Password); err != nil {
			return nil, err
		}
		return a.VaultState(), nil
	})
	api("POST /api/vault/unlock", func(w http.ResponseWriter, r *http.Request) (any, error) {
		var q pwReq
		if err := decode(r, &q); err != nil {
			return nil, err
		}
		if err := a.UnlockVault(q.Password); err != nil {
			return nil, err
		}
		return a.VaultState(), nil
	})
	api("POST /api/vault/lock", func(w http.ResponseWriter, r *http.Request) (any, error) {
		a.Store.LockVault()
		return a.VaultState(), nil
	})
	api("POST /api/vault/reset", func(w http.ResponseWriter, r *http.Request) (any, error) {
		if err := a.ResetVault(); err != nil {
			return nil, err
		}
		return a.VaultState(), nil
	})

	// 服务器
	api("GET /api/servers", func(w http.ResponseWriter, r *http.Request) (any, error) {
		return a.List(), nil
	})
	api("POST /api/servers", func(w http.ResponseWriter, r *http.Request) (any, error) {
		var q struct {
			Servers []model.ServerInput `json:"servers"`
		}
		if err := decode(r, &q); err != nil {
			return nil, err
		}
		return a.AddServers(q.Servers)
	})
	api("POST /api/servers/parse", func(w http.ResponseWriter, r *http.Request) (any, error) {
		var q struct {
			Text     string `json:"text"`
			Defaults struct {
				Port     int    `json:"port"`
				User     string `json:"user"`
				AuthType string `json:"authType"`
			} `json:"defaults"`
		}
		if err := decode(r, &q); err != nil {
			return nil, err
		}
		list, errs := app.ParseBatch(q.Text, q.Defaults.Port, q.Defaults.User, q.Defaults.AuthType)
		if list == nil {
			list = []model.ServerInput{}
		}
		if errs == nil {
			errs = []string{}
		}
		return map[string]any{"servers": list, "errors": errs}, nil
	})
	api("PATCH /api/servers/{id}", func(w http.ResponseWriter, r *http.Request) (any, error) {
		var q model.ServerInput
		if err := decode(r, &q); err != nil {
			return nil, err
		}
		return a.UpdateServer(r.PathValue("id"), q)
	})
	api("DELETE /api/servers/{id}", func(w http.ResponseWriter, r *http.Request) (any, error) {
		return nil, a.RemoveServer(r.PathValue("id"))
	})
	api("PUT /api/servers/{id}/selected", func(w http.ResponseWriter, r *http.Request) (any, error) {
		var q struct {
			Selected []string `json:"selected"`
		}
		if err := decode(r, &q); err != nil {
			return nil, err
		}
		return a.SetSelected(r.PathValue("id"), q.Selected)
	})
	taskResp := func(id string, err error) (any, error) {
		if err != nil {
			return nil, err
		}
		return map[string]string{"taskId": id}, nil
	}
	api("POST /api/servers/{id}/detect", func(w http.ResponseWriter, r *http.Request) (any, error) {
		var q struct {
			TrustNewKey bool `json:"trustNewKey"`
		}
		decode(r, &q)
		return taskResp(a.Detect(r.PathValue("id"), q.TrustNewKey, false))
	})
	api("POST /api/servers/{id}/probe", func(w http.ResponseWriter, r *http.Request) (any, error) {
		var q struct {
			Addrs []string `json:"addrs"`
			Bind  bool     `json:"bind"`
		}
		if err := decode(r, &q); err != nil {
			return nil, err
		}
		return taskResp(a.Probe(r.PathValue("id"), strings.Join(q.Addrs, "\n"), q.Bind))
	})
	api("POST /api/servers/{id}/plan", func(w http.ResponseWriter, r *http.Request) (any, error) {
		var q model.PlanRequest
		if err := decode(r, &q); err != nil {
			return nil, err
		}
		res, err := a.Plan(r.PathValue("id"), q)
		if err != nil {
			return nil, err
		}
		if res.Proxies == nil {
			res.Proxies = []model.Proxy{}
		}
		return res, nil
	})
	api("POST /api/servers/{id}/deploy", func(w http.ResponseWriter, r *http.Request) (any, error) {
		var q model.PlanRequest
		if err := decode(r, &q); err != nil {
			return nil, err
		}
		return taskResp(a.Deploy(r.PathValue("id"), q, false))
	})
	api("POST /api/servers/{id}/test", func(w http.ResponseWriter, r *http.Request) (any, error) {
		var q struct {
			Where string `json:"where"`
		}
		decode(r, &q)
		return taskResp(a.Test(r.PathValue("id"), q.Where, false))
	})
	api("POST /api/servers/{id}/refresh", func(w http.ResponseWriter, r *http.Request) (any, error) {
		return taskResp(a.Refresh(r.PathValue("id"), false))
	})
	api("POST /api/servers/{id}/service", func(w http.ResponseWriter, r *http.Request) (any, error) {
		var q struct {
			Action string `json:"action"`
		}
		decode(r, &q)
		return taskResp(a.Service(r.PathValue("id"), q.Action))
	})
	api("POST /api/servers/{id}/uninstall", func(w http.ResponseWriter, r *http.Request) (any, error) {
		return taskResp(a.Uninstall(r.PathValue("id")))
	})
	api("POST /api/batch", func(w http.ResponseWriter, r *http.Request) (any, error) {
		var q struct {
			Action   string          `json:"action"`
			IDs      []string        `json:"ids"`
			Settings *model.Settings `json:"settings"`
		}
		if err := decode(r, &q); err != nil {
			return nil, err
		}
		ids, err := a.Batch(q.Action, q.IDs, q.Settings)
		if err != nil {
			return nil, err
		}
		return map[string]any{"taskIds": ids}, nil
	})
	api("GET /api/tasks/{id}", func(w http.ResponseWriter, r *http.Request) (any, error) {
		t, ok := a.Tasks.Get(r.PathValue("id"))
		if !ok {
			return nil, errors.New("任务不存在")
		}
		return t, nil
	})
	api("POST /api/tasks/{id}/cancel", func(w http.ResponseWriter, r *http.Request) (any, error) {
		a.Tasks.Cancel(r.PathValue("id"))
		return nil, nil
	})
	mux.HandleFunc("GET /api/events", s.events)
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "接口不存在"})
	})
	mux.Handle("/", s.static())
	return s.guard(mux)
}

// guard 校验 Host 头与令牌，并加安全响应头。
func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		host = strings.Trim(host, "[]")
		if !s.AllowHosts[host] && host != "localhost" && host != "127.0.0.1" && host != "::1" {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			tok := r.Header.Get("X-Token")
			// 查询参数里的令牌只给 SSE 用（EventSource 无法设置请求头）。其它接口必须用请求头：
			// 跨站页面发不出带自定义头的请求（会触发 CORS 预检而被拦），即使令牌泄露或固定（-dev）也无法 CSRF
			if tok == "" && r.Method == http.MethodGet && r.URL.Path == "/api/events" {
				tok = r.URL.Query().Get("t")
			}
			if subtle.ConstantTimeCompare([]byte(tok), []byte(s.Token)) != 1 {
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "令牌无效，请使用程序启动时打开的地址访问"})
				return
			}
			w.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) static() http.Handler {
	fileServer := http.FileServer(http.FS(s.UI))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == "" {
			p = "index.html"
		}
		if _, err := fs.Stat(s.UI, p); err != nil {
			// SPA：未知路径返回首页
			r.URL.Path = "/"
			p = "index.html"
		}
		if p == "index.html" {
			if _, err := fs.Stat(s.UI, "index.html"); err != nil {
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				io.WriteString(w, "<h1>前端未构建</h1><p>请先在 web 目录执行 npm install &amp;&amp; npm run build，再重新编译程序。</p>")
				return
			}
			w.Header().Set("Cache-Control", "no-cache")
		} else {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		fileServer.ServeHTTP(w, r)
	})
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	ch, unsub := s.App.Bus.Subscribe()
	defer unsub()
	send := func(e model.Event) error {
		b, err := json.Marshal(e)
		if err != nil {
			return err
		}
		if _, err := fmt.Fprintf(w, "data: %s\n\n", b); err != nil {
			return err
		}
		fl.Flush()
		return nil
	}
	for _, v := range s.App.List() {
		v := v
		send(model.Event{Type: "server", Server: &v})
	}
	for _, t := range s.App.Tasks.Running() {
		t := t
		send(model.Event{Type: "task", Task: &t})
	}
	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case e := <-ch:
			if send(e) != nil {
				return
			}
		case <-ping.C:
			if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
				return
			}
			fl.Flush()
		}
	}
}

func decode(r *http.Request, v any) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, 16<<20))
	if err != nil {
		return err
	}
	if len(strings.TrimSpace(string(body))) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, v); err != nil {
		return fmt.Errorf("请求格式错误: %v", err)
	}
	return nil
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}
