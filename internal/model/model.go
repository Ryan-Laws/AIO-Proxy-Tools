// Package model 定义前后端与服务器端共享的数据结构。
// JSON 字段名即 API 约定，修改时需同步 web/src/api/types.ts。
package model

import "time"

// ---------- 服务器探测 ----------

// Addr 是服务器上一个可用作代理的地址。
type Addr struct {
	IP       string `json:"ip"`
	Prefix   int    `json:"prefix"`
	Iface    string `json:"iface"`
	Family   int    `json:"family"`   // 4 或 6
	Source   string `json:"source"`   // nic | anyip | manual
	Public   string `json:"public"`   // 实测出口公网 IP，未知为空
	Probe    string `json:"probe"`    // "" 未探测 | ok | fail
	NeedBind bool   `json:"needBind"` // 手动添加且不在网卡上，部署时需绑定
}

// ServerInfo 是 detect.sh 的解析结果。
type ServerInfo struct {
	OS           string    `json:"os"`
	OSID         string    `json:"osId"`
	OSVersion    string    `json:"osVersion"`
	Kernel       string    `json:"kernel"`
	Arch         string    `json:"arch"`
	Init         string    `json:"init"` // systemd | openrc | unknown
	PM           string    `json:"pm"`
	IsRoot       bool      `json:"isRoot"`
	HasCurl      bool      `json:"hasCurl"`
	HasWget      bool      `json:"hasWget"`
	Firewalls    []string  `json:"firewalls"`
	TCPCC        string    `json:"tcpCC"`
	MemMB        int       `json:"memMB"`
	CPUs         int       `json:"cpus"`
	Installed    bool      `json:"installed"`
	Version      string    `json:"version"`   // 已安装的 3proxy 版本
	Conflicts    []string  `json:"conflicts"` // 检测到的其它代理服务
	DefaultIface string    `json:"defaultIface"`
	Listening    []string  `json:"listening"` // 已占用的 "地址:端口"
	Addrs        []Addr    `json:"addrs"`
	AnyIP        []string  `json:"anyIP"` // AnyIP 网段
	Warnings     []string  `json:"warnings"`
	DetectedAt   time.Time `json:"detectedAt"`
}

// ---------- 代理设置 ----------

// Settings 是"代理设置"页的全部选项。
type Settings struct {
	Protocol      string   `json:"protocol"` // socks | http | dual | auto
	Socks         PortRule `json:"socks"`
	HTTP          PortRule `json:"http"`
	Auth          AuthRule `json:"auth"`
	Whitelist     []string `json:"whitelist"` // 来源 IP/网段白名单
	Limits        Limits   `json:"limits"`    // 每个代理的默认限制
	DNS           DNSRule  `json:"dns"`
	KeepExisting  bool     `json:"keepExisting"` // 已部署的 IP 沿用原端口和账号
	Firewall      bool     `json:"firewall"`
	BBR           bool     `json:"bbr"`
	Tune          bool     `json:"tune"` // 内核参数调优
	BlockPrivate  bool     `json:"blockPrivate"`
	UDP           bool     `json:"udp"` // SOCKS5 UDP（实验性）
	Log           bool     `json:"log"`
	MaxConn       int      `json:"maxConn"` // 每个监听服务的最大并发
	StopConflicts []string `json:"stopConflicts"`
	GitHubMirror  string   `json:"githubMirror"`
}

// PortRule 描述一个协议的端口分配方式。
type PortRule struct {
	Mode     string `json:"mode"` // same | inc | random
	Port     int    `json:"port"` // same/inc 的端口或起始端口
	RangeMin int    `json:"rangeMin"`
	RangeMax int    `json:"rangeMax"`
}

// AuthRule 描述账号生成方式。
type AuthRule struct {
	Mode       string `json:"mode"` // per | shared | custom | list | none
	User       string `json:"user"`
	Pass       string `json:"pass"`
	UserPrefix string `json:"userPrefix"`
	UserLen    int    `json:"userLen"`
	PassLen    int    `json:"passLen"`
	List       []Cred `json:"list"` // mode=list 时按顺序分配
}

type Cred struct {
	User string `json:"user"`
	Pass string `json:"pass"`
}

// Limits 是单个代理（账号）的限制，0 表示不限。
type Limits struct {
	SpeedMbps   float64 `json:"speedMbps"`   // 上下行各自的限速
	MaxConn     int     `json:"maxConn"`     // 最大并发连接
	QuotaGB     float64 `json:"quotaGB"`     // 周期流量额度
	QuotaPeriod string  `json:"quotaPeriod"` // D | W | M
	ExpiresAt   string  `json:"expiresAt"`   // YYYY-MM-DD，到期后停用
}

// DNSRule 描述服务器端域名解析方式。
type DNSRule struct {
	Mode    string   `json:"mode"`    // recursive | forward | public | system | custom
	Servers []string `json:"servers"` // forward/public/custom 用
}

// ---------- 代理清单 ----------

// Proxy 是最终部署的一个监听服务。双协议分端口时一个 IP 对应两条。
type Proxy struct {
	ID        string   `json:"id"`
	Listen    string   `json:"listen"` // 服务器网卡上的地址
	Public    string   `json:"public"` // 客户端连接用的地址（NAT 时为公网 IP）
	Family    int      `json:"family"`
	Iface     string   `json:"iface"`
	Prefix    int      `json:"prefix"`
	NeedBind  bool     `json:"needBind"`
	Protocol  string   `json:"protocol"` // socks | http | auto
	Port      int      `json:"port"`
	User      string   `json:"user"`
	Pass      string   `json:"pass"`
	Slot      int      `json:"slot"` // 流量计数槽位（按账号）
	Limits    Limits   `json:"limits"`
	Whitelist []string `json:"whitelist"`
}

// Manifest 保存在服务器 /etc/aio-proxy/proxies.json，用于还原已部署状态。
type Manifest struct {
	Version      int       `json:"version"`
	Tool         string    `json:"tool"`
	UpdatedAt    time.Time `json:"updatedAt"`
	Settings     Settings  `json:"settings"`
	Proxies      []Proxy   `json:"proxies"`
	AdminPort    int       `json:"adminPort"`
	AdminUser    string    `json:"adminUser"`
	AdminPass    string    `json:"adminPass"`
	DNSEffective string    `json:"dnsEffective"`
	// MaxSlot 是历史上分配过的最大流量计数槽位：只增不减，避免新账号继承已删除账号的流量
	MaxSlot int `json:"maxSlot,omitempty"`
}

// ---------- 测试与统计 ----------

type TestResult struct {
	ProxyID   string `json:"proxyId"`
	Where     string `json:"where"` // local | server
	OK        bool   `json:"ok"`
	Egress    string `json:"egress"`
	Expected  string `json:"expected"`
	LatencyMs int    `json:"latencyMs"`
	AuthOK    *bool  `json:"authOK,omitempty"` // 不带密码是否被拒
	Error     string `json:"error,omitempty"`
}

type Stat struct {
	User    string  `json:"user"`
	Slot    int     `json:"slot"`
	UsedMB  float64 `json:"usedMB"`
	LimitMB float64 `json:"limitMB"`
	Period  string  `json:"period"`
}

type ServiceStatus struct {
	Active      bool   `json:"active"`
	DNSActive   bool   `json:"dnsActive"`
	PID         int    `json:"pid"`
	Threads     int    `json:"threads"`
	MemMB       int    `json:"memMB"`
	Connections int    `json:"connections"`
	Since       string `json:"since"`
}
