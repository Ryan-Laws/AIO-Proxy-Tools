// Package task 管理后台任务（日志、进度、取消）以及向前端推送事件的总线。
package task

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"strings"
	"sync"
	"time"

	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/model"
)

// Bus 把事件广播给所有 SSE 订阅者。
type Bus struct {
	mu   sync.Mutex
	subs map[chan model.Event]struct{}
}

func NewBus() *Bus { return &Bus{subs: map[chan model.Event]struct{}{}} }

func (b *Bus) Subscribe() (chan model.Event, func()) {
	ch := make(chan model.Event, 512)
	b.mu.Lock()
	b.subs[ch] = struct{}{}
	b.mu.Unlock()
	return ch, func() {
		b.mu.Lock()
		delete(b.subs, ch)
		b.mu.Unlock()
	}
}

func (b *Bus) Publish(e model.Event) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.subs {
		select {
		case ch <- e:
		default: // 慢订阅者丢弃事件，前端重连时会拿到快照
		}
	}
}

// Task 是一个正在运行或已结束的任务。
type Task struct {
	mu     sync.Mutex
	v      model.TaskView
	cancel context.CancelFunc
	bus    *Bus
}

const maxLogs = 5000

func (t *Task) snapshot(withLogs bool) model.TaskView {
	t.mu.Lock()
	defer t.mu.Unlock()
	v := t.v
	if withLogs {
		v.Logs = append([]model.LogLine(nil), t.v.Logs...)
	} else {
		v.Logs = nil
	}
	return v
}

func (t *Task) publish() {
	v := t.snapshot(false)
	t.bus.Publish(model.Event{Type: "task", Task: &v})
}

// Log 追加一行日志。level 为空时按 "::级别::" 前缀自动识别。
func (t *Task) Log(level, text string) {
	if level == "" {
		level = "info"
		if strings.HasPrefix(text, "::") {
			if i := strings.Index(text[2:], "::"); i >= 0 {
				level = text[2 : 2+i]
				text = text[4+i:]
			}
		}
	}
	switch level {
	case "step", "ok", "warn", "error", "info":
	default:
		level = "info"
	}
	l := model.LogLine{T: time.Now(), Level: level, Text: text}
	t.mu.Lock()
	if len(t.v.Logs) >= maxLogs {
		t.v.Logs = t.v.Logs[len(t.v.Logs)-maxLogs/2:]
	}
	t.v.Logs = append(t.v.Logs, l)
	if level == "step" {
		t.v.Step = text
	}
	id := t.v.ID
	t.mu.Unlock()
	t.bus.Publish(model.Event{Type: "log", ID: id, Log: &l})
	if level == "step" {
		t.publish()
	}
}

func (t *Task) Step(text string) { t.Log("step", text) }
func (t *Task) Info(f string)    { t.Log("info", f) }
func (t *Task) OK(f string)      { t.Log("ok", f) }
func (t *Task) Warn(f string)    { t.Log("warn", f) }
func (t *Task) Error(f string)   { t.Log("error", f) }

// Progress 更新进度。
func (t *Task) Progress(done, total int) {
	t.mu.Lock()
	t.v.Done, t.v.Total = done, total
	t.mu.Unlock()
	t.publish()
}

func (t *Task) AddDone(n int) {
	t.mu.Lock()
	t.v.Done += n
	t.mu.Unlock()
	t.publish()
}

func (t *Task) ID() string { return t.v.ID }

// Manager 管理全部任务。
type Manager struct {
	mu    sync.Mutex
	tasks map[string]*Task
	bus   *Bus
}

func NewManager(bus *Bus) *Manager { return &Manager{tasks: map[string]*Task{}, bus: bus} }

func newID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// Start 在后台运行 fn；onEnd 在任务结束后调用（用于更新服务器状态）。
func (m *Manager) Start(serverID, kind string, fn func(ctx context.Context, t *Task) error, onEnd func(t *Task, err error)) *Task {
	ctx, cancel := context.WithCancel(context.Background())
	t := &Task{bus: m.bus, cancel: cancel, v: model.TaskView{
		ID: newID(), ServerID: serverID, Kind: kind, State: "running", StartedAt: time.Now(),
	}}
	m.mu.Lock()
	m.tasks[t.v.ID] = t
	m.gcLocked()
	m.mu.Unlock()
	t.publish()
	go func() {
		var err error
		func() {
			defer func() {
				if r := recover(); r != nil {
					err = errPanic{r}
				}
			}()
			err = fn(ctx, t)
		}()
		t.mu.Lock()
		t.v.EndedAt = time.Now()
		switch {
		case ctx.Err() != nil:
			t.v.State = "canceled"
			t.v.Error = "已取消"
		case err != nil:
			t.v.State = "failed"
			t.v.Error = err.Error()
		default:
			t.v.State = "done"
		}
		t.mu.Unlock()
		if err != nil && ctx.Err() == nil {
			t.Error(err.Error())
		}
		t.publish()
		cancel()
		if onEnd != nil {
			onEnd(t, err)
		}
	}()
	return t
}

type errPanic struct{ v any }

func (e errPanic) Error() string { return "内部错误: " + strings.TrimSpace(sprint(e.v)) }

func sprint(v any) string {
	if e, ok := v.(error); ok {
		return e.Error()
	}
	if s, ok := v.(string); ok {
		return s
	}
	return "panic"
}

// gcLocked 只保留最近 200 个已结束任务。
func (m *Manager) gcLocked() {
	if len(m.tasks) < 300 {
		return
	}
	type kv struct {
		id string
		t  time.Time
	}
	var ended []kv
	for id, t := range m.tasks {
		if v := t.snapshot(false); v.State != "running" {
			ended = append(ended, kv{id, v.EndedAt})
		}
	}
	for len(ended) > 200 {
		oldest := 0
		for i := range ended {
			if ended[i].t.Before(ended[oldest].t) {
				oldest = i
			}
		}
		delete(m.tasks, ended[oldest].id)
		ended = append(ended[:oldest], ended[oldest+1:]...)
	}
}

func (m *Manager) Get(id string) (model.TaskView, bool) {
	m.mu.Lock()
	t, ok := m.tasks[id]
	m.mu.Unlock()
	if !ok {
		return model.TaskView{}, false
	}
	return t.snapshot(true), true
}

func (m *Manager) Cancel(id string) bool {
	m.mu.Lock()
	t, ok := m.tasks[id]
	m.mu.Unlock()
	if ok {
		t.cancel()
	}
	return ok
}

// Running 返回运行中任务的快照。
func (m *Manager) Running() []model.TaskView {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []model.TaskView
	for _, t := range m.tasks {
		if v := t.snapshot(false); v.State == "running" {
			out = append(out, v)
		}
	}
	return out
}
