package model

import "time"

// ServerView 是服务器列表里一台机器的完整状态（不含任何密码）。
type ServerView struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	Host        string         `json:"host"`
	Port        int            `json:"port"`
	User        string         `json:"user"`
	AuthType    string         `json:"authType"`  // password | key
	HasSecret   bool           `json:"hasSecret"` // 内存中是否有可用凭据
	Remember    bool           `json:"remember"`  // 是否保存到加密保险箱
	State       string         `json:"state"`     // new | connecting | ready | deploying | deployed | error
	Error       string         `json:"error"`
	Info        *ServerInfo    `json:"info"`
	Selected    []string       `json:"selected"` // 已勾选的 IP
	Manifest    *Manifest      `json:"manifest"` // 服务器上已部署的清单
	Tests       []TestResult   `json:"tests"`
	Stats       []Stat         `json:"stats"`
	Status      *ServiceStatus `json:"status"`
	TaskID      string         `json:"taskId"` // 正在执行的任务
	Fingerprint string         `json:"fingerprint"`
	UpdatedAt   time.Time      `json:"updatedAt"`
}

// ServerInput 是添加/修改服务器时提交的内容。
type ServerInput struct {
	Name       string `json:"name"`
	Host       string `json:"host"`
	Port       int    `json:"port"`
	User       string `json:"user"`
	AuthType   string `json:"authType"`
	Password   string `json:"password"`
	Key        string `json:"key"`
	Passphrase string `json:"passphrase"`
	Remember   bool   `json:"remember"`
}

// TaskView 是一个后台任务的快照。
type TaskView struct {
	ID        string    `json:"id"`
	ServerID  string    `json:"serverId"`
	Kind      string    `json:"kind"`  // detect | probe | deploy | test | refresh | service | uninstall
	State     string    `json:"state"` // running | done | failed | canceled
	Step      string    `json:"step"`
	Done      int       `json:"done"`
	Total     int       `json:"total"`
	Error     string    `json:"error"`
	Logs      []LogLine `json:"logs,omitempty"`
	StartedAt time.Time `json:"startedAt"`
	EndedAt   time.Time `json:"endedAt,omitempty"`
}

type LogLine struct {
	T     time.Time `json:"t"`
	Level string    `json:"level"` // info | ok | warn | error | step
	Text  string    `json:"text"`
}

// PlanRequest 用于预览和部署。
type PlanRequest struct {
	Settings Settings `json:"settings"`
	Selected []string `json:"selected"`
	// Edited 为预览后用户在表格中修改过的清单；为空则按 Settings 重新生成。
	Edited []Proxy `json:"edited"`
}

type PlanResult struct {
	Proxies  []Proxy  `json:"proxies"`
	Warnings []string `json:"warnings"`
	Errors   []string `json:"errors"`
	Ports    []string `json:"ports"` // 占用端口摘要，如 "tcp 1080"、"tcp 20000-20255"
}

// Preferences 是本机偏好设置。
type Preferences struct {
	SaveHistory bool     `json:"saveHistory"`
	Concurrency int      `json:"concurrency"`
	Defaults    Settings `json:"defaults"`
	Theme       string   `json:"theme"` // system | light | dark
}

// Event 通过 SSE 推送到前端。
type Event struct {
	Type   string      `json:"type"` // server | server-removed | task | log
	Server *ServerView `json:"server,omitempty"`
	Task   *TaskView   `json:"task,omitempty"`
	ID     string      `json:"id,omitempty"`
	Log    *LogLine    `json:"log,omitempty"`
}
