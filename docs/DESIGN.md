# AIO Proxy Tools 设计文档

> 状态：**已确认并实现**（2026-10）。本文记录关键设计决策，细节以代码为准。
> 文中所有 IP 均为文档保留地址（203.0.113.0/24、198.51.100.0/24、2001:db8::/32），不涉及任何真实机器。

---

## 1. 目标

一个**轻量、跨平台、傻瓜化**的图形工具：填入 VPS 的 SSH 信息，自动识别机器上的全部 IP，一键把每个 IP 搭成独立的 SOCKS5 / HTTP 代理（从哪个 IP 进、就从哪个 IP 出），并自动测试、导出。

- 支持 1 个 IP 到整段（/24 及更多段）的机器
- 支持一次批量部署多台服务器
- 开源（MIT），代码与文档中不包含任何真实 IP、账号、密码

## 2. 已确定的技术决策

| 项 | 决定 | 理由 |
|---|---|---|
| 本机程序 | **Go 单文件**，`CGO_ENABLED=0` | 一份代码交叉编译 Windows / macOS / Linux，零运行时依赖，约 10MB |
| 界面外壳 | **系统浏览器** | 程序启动后自动打开 `http://127.0.0.1:<随机端口>/?t=<令牌>`；无桌面的 Linux 也能用（打印地址） |
| 前端 | **React + Vite + TypeScript + shadcn/ui (Tailwind)** | 现代美观、深浅色主题；构建产物通过 `go:embed` 打进程序 |
| SSH | `golang.org/x/crypto/ssh`（内置） | 不依赖系统 ssh，三平台行为一致 |
| 服务器端内核 | **只用 3proxy 1.0.1** | 原生多 IP 进出绑定、占用极低、支持限速/限连接/流量计数、配置热重载 |
| 服务器端脚本 | POSIX `sh` | 兼容没有 bash 的 Alpine |
| 许可证 | MIT | 3proxy 部署时从官方获取，不随本程序分发 |

## 3. 功能清单

### 3.1 服务器管理（批量）
- **添加服务器**：单台表单填写；或**批量粘贴**（每行 `host[:port] [user] [password]`）；或导入 CSV
- 认证：密码 / 私钥（可带口令，支持选择文件或粘贴）/ 键盘交互
- 非 root 用户：自动 `sudo`（有密码用 `sudo -S`，免密用 `sudo -n`），无 sudo 权限时明确报错
- **主机密钥 TOFU**：首次连接记录指纹并显示；指纹变化时拒绝连接并提示，可手动"信任新密钥"
- 服务器列表显示：状态（未连接 / 探测中 / 待配置 / 部署中 / 完成 / 失败）、系统、IP 数、代理数
- 批量并发：默认同时处理 3 台，可调（1~10）
- **密码只保存在内存**，关闭程序即清除；本机只保存"地址 + 端口 + 用户名"的历史（可在设置里关闭）

### 3.2 自动探测（只读，不改系统）
- 系统发行版与版本、内核、CPU 架构、init（systemd / OpenRC）、包管理器（apt / dnf / yum / apk / pacman / zypper）
- 防火墙：ufw / firewalld / iptables / nftables 是否启用
- 已安装状态：本工具是否部署过、是否存在其它代理服务（3proxy / sing-box / dante 等）
- 已占用端口（地址:端口 粒度，用于冲突检查）
- **IP 识别**：
  - 网卡上的全局 IPv4 / IPv6（排除 lo、docker、veth、virbr、cni、tun、wg 等虚拟网卡；排除 IPv6 临时/弃用地址）
  - **AnyIP 整段**（`ip route ... table local` 中的 local 网段，常见于包段机器）→ 自动展开为单个地址
  - **出口实测**：从每个地址分别访问 IP 回显服务，得到其真实出口公网 IP，自动识别 NAT 映射（云服务器"网卡上是内网 IP、对外是公网 IP"）
  - 并发探测（48 路），256 个 IP 约 10~20 秒
- 手动补充：输入单个 IP / CIDR / 范围（`203.0.113.10-203.0.113.50`），可选"**自动绑定到网卡**"（持久化，开机自动恢复）

### 3.3 IP 选择
- 表格列：☑ / 网卡 / 本机地址 / 出口公网 IP / 类型（v4 / v6 / AnyIP / 手动）/ 探测结果
- 操作：全选、反选、仅 IPv4、仅可用（出口探测成功）、按网段筛选、搜索
- 大列表虚拟滚动（上千行不卡）

### 3.4 代理设置（细粒度，用户自选）

**协议**（四选一）
| 模式 | 说明 | 每个 IP 占用端口 |
|---|---|---|
| 仅 SOCKS5 | 3proxy `socks` | 1 |
| 仅 HTTP | 3proxy `proxy`（支持 CONNECT / HTTPS） | 1 |
| 双协议 · 分端口（默认） | SOCKS5 与 HTTP 各一个端口，兼容性最好 | 2 |
| 双协议 · 同端口 | 3proxy `auto`，一个端口自动识别 | 1 |

**端口**（每个协议单独设置）
- 统一端口：所有 IP 用同一端口（各 IP 独立绑定，不冲突），如 SOCKS5=1080、HTTP=8080
- 递增端口：从起始端口按 IP 顺序递增，如 20000、20001…（适合"一个 IP 一个端口"的分发方式）
- 随机端口：在指定范围内随机且不冲突
- **单行覆盖**：在预览表里可以直接改某个 IP 的端口

**账号**
- 每个 IP 独立随机 / 所有 IP 共用一组随机 / 自定义统一账号 / 批量导入账号表 / 无认证（必须设置来源 IP 白名单，否则拒绝部署）
- 随机规则：用户名前缀 + 长度、密码长度（默认 16），字符集 `A-Za-z0-9`（避免 `:` `@` 破坏导出格式）
- 可选 **来源 IP 白名单**（只允许指定 IP/网段使用，可与账号同时使用）
- 重新部署时：已部署过的 IP 可选"**沿用原端口和账号**"（从服务器读取现有配置，默认开）

**系统选项**
- 自动放行防火墙（默认开）
- 开启 BBR（默认开，内核不支持则跳过）
- 停用冲突的旧代理服务（默认关，检测到冲突时提示）
- 连接日志（默认关，出于隐私）

**部署前预览**：生成完整代理清单（IP / 端口 / 账号），确认后才执行。

### 3.5 部署
- 实时日志（SSE 推送），每台服务器独立日志面板，可展开/折叠
- 失败可重试单台；整体进度条
- 详见第 6 节

### 3.6 测试
- **本机实测**（默认部署后自动执行）：每个代理测试
  - 连通性与延迟
  - 出口 IP 是否等于预期（防止串 IP）
  - 不带密码是否被拒绝（防止成为开放代理）
- **服务器自测**：本机测试失败时自动在服务器上用 curl 测一遍；
  服务器通过 + 本机失败 ⇒ 提示"大概率是云厂商安全组未放行端口"
- 并发 32 路，可随时重测单个 / 全部

### 3.7 导出
- 格式（可选，均支持选择 SOCKS5 / HTTP / 两者）：
  - `ip:port:user:pass`
  - `user:pass@ip:port`
  - `socks5://user:pass@ip:port`、`http://user:pass@ip:port`
  - CSV（含服务器、协议、出口 IP、测试结果）
  - 自定义模板，如 `{ip}:{port}:{user}:{pass}`
- 一键复制 / 下载 `.txt` / `.csv`；可只导出"测试通过"的
- 批量时可按服务器分开或合并导出

### 3.8 管理
- **查看已部署**：从服务器读取当前配置还原代理清单（本机不存任何代理密码）
- 修改后重新部署（3proxy 热重载，不断开现有连接）
- 启动 / 停止 / 重启服务、查看服务状态
- **一键卸载**：停服务、删文件、撤销防火墙规则、移除本工具绑定的 IP

### 3.9 限制与计费（第一版已包含）
- 按 IP / 用户限速（`bandlimin/bandlimout`）、最大连接数（`maxconn/connlim`）
- 流量统计与额度（`counter`），到期自动停用
- 界面英文版（i18n 结构第一版就预留）

## 4. 界面设计

整体：左侧服务器列表，右侧为所选服务器的工作区（标签页）。顶部为全局操作。深浅色主题跟随系统，可手动切换。

```
┌ aio-proxy ──────────────────────────────── [批量部署] [全部导出] [设置] [◐] ┐
│ 服务器               │ 203.0.113.10 · Ubuntu 22.04 · x86_64 · systemd · ufw  │
│ [+ 添加] [批量粘贴]  │ ┌[IP 列表]─[代理设置]─[部署日志]─[代理清单]─[管理]┐    │
│                      │ │                                                │    │
│ ● 203.0.113.10  完成 │ │  [全选][反选][仅IPv4][仅可用][+手动添加]  搜索… │    │
│   256 IP · 512 代理  │ │  ☑ eth0  203.0.113.10  → 203.0.113.10  v4  ✓   │    │
│ ◐ 198.51.100.7 部署中│ │  ☑ lo    203.0.113.11  → 203.0.113.11  AnyIP ✓ │    │
│   11 IP · 进度 6/11  │ │  ☐ eth0  10.0.0.5      → 198.51.100.7  NAT ✓   │    │
│ ○ 198.51.100.8 待配置│ │  ☐ eth0  2001:db8::1   → 2001:db8::1   v6  ✓   │    │
│ ✕ 198.51.100.9 失败  │ │  …                          已选 11 / 256      │    │
│                      │ └────────────────────────────────────────────────┘    │
└──────────────────────┴───────────────────────────────────────────────────────┘
```

- **添加服务器**：对话框（单台表单 / 批量粘贴两个标签）
- **代理设置**：分组卡片（协议 / 端口 / 账号 / 系统选项），右侧实时显示"将生成 N 个代理、占用端口 …"；可"应用到所有选中服务器"
- **代理清单**：表格（IP / 协议 / 端口 / 用户 / 密码(可显隐) / 出口 / 测试结果 / 延迟），顶部格式选择 + 复制 / 下载 / 重新测试
- 所有危险操作（卸载、无认证、停用旧服务）都有确认对话框
- 页面宽度适配到手机（单列布局）

## 5. 软件架构

```
┌─────────────────────── 本机：aio-proxy（Go 单文件）────────────────────────┐
│  浏览器 (React SPA)  ⇄  HTTP JSON API + SSE                                   │
│                          │                                                    │
│   internal/web      本地服务：仅 127.0.0.1，随机端口，随机令牌，校验 Host 头     │
│   internal/task     任务队列：批量并发、日志流、取消                            │
│   internal/sshx     SSH 连接、sudo 包装、上传文件、执行脚本、主机密钥 TOFU      │
│   internal/detect   解析探测输出 → 服务器信息 + IP 列表                         │
│   internal/plan     设置 + 选中 IP → 代理清单（端口/账号分配、冲突检查）        │
│   internal/threeproxy  代理清单 → 3proxy 配置文件 / 从配置还原清单             │
│   internal/tester   本机实测（SOCKS5 / HTTP / 出口 IP / 拒绝无认证）           │
│   internal/store    本机设置与服务器历史（不含密码）                            │
│   scripts/*.sh      服务器端脚本（go:embed）                                   │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │ SSH（脚本上传到临时目录后执行）
┌──────────────────────────────────────▼───────────────────────────────────────┐
│ VPS：detect.sh → probe.sh → install.sh → 3proxy 服务（systemd / OpenRC）       │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 5.1 本地 Web 服务的安全
- 只监听 `127.0.0.1`（可用 `-listen` 改，非本机地址时强制要求令牌并给出警告）
- 每次启动生成随机令牌，所有 API 必须带 `X-Token` 头；校验 `Host` 头防 DNS 重绑定
- 浏览器关闭后程序继续运行，托盘不做；命令行窗口里 Ctrl+C 退出

### 5.2 API 草案
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/servers` | 添加服务器（单台/批量） |
| DELETE | `/api/servers/{id}` | 移除 |
| POST | `/api/servers/{id}/detect` | 连接并探测（任务） |
| POST | `/api/servers/{id}/probe` | 对手动添加的 IP 做出口探测（任务） |
| POST | `/api/servers/{id}/plan` | 设置 → 代理清单预览（含冲突检查） |
| POST | `/api/servers/{id}/deploy` | 部署（任务） |
| POST | `/api/servers/{id}/test` | 本机 / 服务器测试（任务） |
| GET | `/api/servers/{id}/proxies` | 读取服务器上已部署的清单 |
| POST | `/api/servers/{id}/service` | start / stop / restart / status |
| POST | `/api/servers/{id}/uninstall` | 卸载（任务） |
| GET | `/api/tasks/{id}/events` | SSE：日志行、进度、结果 |

## 6. 服务器端设计（3proxy）

### 6.1 文件布局
```
/opt/aio-proxy/bin/3proxy             二进制
/etc/aio-proxy/3proxy.cfg           主配置（monitor 自身，改动自动热重载）
/etc/aio-proxy/users.cfg            账号（0600）
/etc/aio-proxy/proxies.json         代理清单（供"查看已部署"还原，0600）
/etc/aio-proxy/bind-addrs           需要绑定到网卡的地址（可选）
/etc/aio-proxy/fw.state             本工具添加的防火墙规则（卸载时撤销）
服务名：aio-proxy（DNS：aio-proxy-dns）  以专用用户 aio-proxy 运行
```
使用独立目录和服务名，**不覆盖**机器上已有的 3proxy / sing-box。

### 6.2 安装 3proxy（按顺序回退）
1. 已安装且版本满足 → 复用
2. 官方发布的 deb / rpm（Debian/Ubuntu/RHEL 系，对应架构存在时）
3. 下载官方源码（GitHub 最新 release）在服务器上编译（自动装 gcc/make，Alpine 用 musl 同样可编；约 30~60 秒）
4. 服务器访问不了 GitHub 时：本机下载源码包（走本机代理环境变量）经 SSH 上传，再编译
   - 可在设置里填 GitHub 镜像前缀（默认空，不内置任何第三方镜像）

### 6.3 配置模板（早期示意，最终实现见第 13 节与 internal/threeproxy）
```
nscache 65536
nserver 1.1.1.1            # 可在设置中修改；留空则用系统解析
timeouts 1 5 30 60 180 1800 15 60
maxconn 4096
stacksize 131072           # 降低每连接线程栈，控制内存
monitor /etc/aio-proxy/3proxy.cfg
monitor /etc/aio-proxy/users.cfg
include /etc/aio-proxy/users.cfg
auth strong

# —— 203.0.113.10 ——
flush
allow u7k2m9
socks -p1080 -i203.0.113.10 -e203.0.113.10
proxy -p8080 -i203.0.113.10 -e203.0.113.10

# —— NAT：网卡 10.0.0.5，对外 198.51.100.7 ——
flush
allow u3n8x1
socks -p1080 -i10.0.0.5 -e10.0.0.5

# —— IPv6 ——
flush
allow u9q4w2
socks -6 -p1080 -i2001:db8::1 -e2001:db8::1
```
- 每个 IP 独立 `flush` + `allow`，账号与 IP 一一对应，A 的账号不能用 B 的 IP
- `-i` 监听地址、`-e` 出口地址都是该 IP，保证"哪个 IP 进、哪个 IP 出"
- IPv6 代理只走 IPv6 出站，IPv4 同理，防止出口串到别的地址
- 白名单：`allow user 198.51.100.0/24` 形式叠加

### 6.4 服务
- systemd：`Restart=always`、`RestartSec=3`、开机自启、`User=aio-proxy` + `AmbientCapabilities=CAP_NET_BIND_SERVICE`（允许 <1024 端口）、`LimitNOFILE=1048576`
- OpenRC：`supervise-daemon` 自动重启
- 需要绑定额外 IP 时，启动前执行 `bind-ip.sh`（`ip addr replace`），重启后自动恢复

### 6.5 防火墙
| 防火墙 | 做法 |
|---|---|
| ufw | `ufw allow <端口或范围>/tcp`（SOCKS5 额外 udp） |
| firewalld | `--permanent --add-port=<范围>/tcp` + reload |
| iptables / ip6tables | 插入 ACCEPT 规则，尽力持久化（netfilter-persistent / iptables-save） |
| nftables | 向 `inet filter input` 插入 accept 规则 |
- 连续端口合并成范围，256 个 IP 也只需几条规则
- 所加规则记入 `fw.state`，卸载时精确撤销
- **云厂商安全组无法通过 SSH 修改**，界面会明确提示

### 6.6 部署流程
```
连接 → 探测(detect.sh) → 出口探测(probe.sh) → 用户选 IP、设置
     → 生成清单 & 冲突检查 → 预览确认
     → 上传脚本+配置 → install.sh：装依赖 → 装 3proxy → 绑 IP → 写配置 → 起服务 → 防火墙 → BBR
     → 服务器自检 → 本机实测 → 展示清单
```
所有脚本上传到 `mktemp -d` 临时目录执行，结束后删除；不在命令行参数中出现密码。

## 7. 本机数据与隐私
- 存放位置：`os.UserConfigDir()/aio-proxy-tools/`
  - `known_hosts`：主机密钥指纹
  - `history.json`：服务器地址/端口/用户名（可关闭）
  - `settings.json`：界面偏好、默认代理设置
- **不保存**：SSH 密码、私钥、代理密码
- 程序无遥测、无更新检查（第一版）

## 8. 目录结构
```
aio-proxy-tools/
├─ cmd/aio-proxy-tools/main.go        入口：参数、启动服务、打开浏览器
├─ internal/{web,task,sshx,detect,plan,threeproxy,tester,store}/
├─ scripts/                       服务器端 sh 脚本（detect / probe / install / uninstall / selftest / bind-ip）
├─ web/                           前端（React + Vite + TS + shadcn/ui）
│  └─ dist/                       构建产物（被 go:embed，不提交）
├─ docs/DESIGN.md
├─ .github/workflows/release.yml  打 tag 自动构建 6 个平台并发布
├─ Makefile / build.ps1           本地构建（先前端后 Go）
├─ README.md / README.en.md / LICENSE
└─ .gitignore                     忽略 dist、本地 csv/txt 等含密码文件
```

## 9. 构建与发布
- 产物：`windows-amd64/arm64`、`darwin-amd64/arm64`、`linux-amd64/arm64`
- 开发：`cd web && npm run dev`（代理到 Go 后端）+ `go run ./cmd/aio-proxy --dev`
- 发布：GitHub Actions，打 tag → 构建前端 → 交叉编译 → 附 SHA256 校验文件
- macOS 未签名，README 说明首次打开方式

## 10. 测试计划
- Go 单元测试：探测输出解析、端口/账号分配、3proxy 配置生成与还原、CIDR 展开
- 脚本：shellcheck；在 Docker 中对 Debian / Ubuntu / Rocky / Alpine / Arch 跑安装与卸载（CI）
- 端到端：一台真实多 IP VPS 由维护者手动验收（不进仓库）

## 11. 里程碑
1. **M1 后端核心**：SSH、探测、出口探测、配置生成、安装/卸载脚本、命令行可跑通
2. **M2 前端**：服务器列表、IP 表、设置、部署日志、代理清单、导出
3. **M3 测试与管理**：本机/服务器测试、查看已部署、服务控制、批量并发
4. **M4 发布**：README、CI、多平台构建

## 12. 已确认的决定
1. 项目名 **AIO Proxy Tools**；Go 模块名暂为 `aio-proxy-tools`，建仓后再改为 GitHub 路径。
2. 限速、限连接、流量额度、到期停用**全部进入第一版**（见第 13 节）。
3. 记住密码：**用户自选**。默认只存内存；勾选后用主密码加密保存（scrypt N=2^15 + AES-256-GCM）。
4. DNS：调研结论见第 14 节，默认"本机 unbound 从根递归"。

## 13. 3proxy 实现要点（已在官方 1.0.1 上实测）
- 每个监听服务独立 `flush` + `allow <该IP的账号>`，账号与 IP 一一对应；`-i` 与 `-e` 均为该 IP。
- `proxy -a`：不添加 `Forwarded` / `X-Forwarded-For`，避免泄露客户端 IP（实测确认）。
- `socks -u2`：只接受用户名密码认证。
- 始终拒绝：回环、未指定地址、链路本地（含云厂商元数据 169.254.169.254 / fd00:ec2::254）、阿里云元数据 100.100.100.200，以及服务器自己的全部地址（同一 /24 或 /64 超过 4 个时按整段合并）。开启"禁止内网"时再拒绝 RFC1918、CGNAT、保留段、组播、IPv6 ULA 与 IPv4 映射地址。
- NAT 场景下给 socks/auto 加 `-Ne<公网> -Ni<公网>`，客户端在 BIND/UDP 中拿到可达地址。
- `maxconn` 默认只有 100，按设置写入（默认 2000）；systemd 单元设置 `LimitNOFILE`、`TasksMax=infinity`（官方高负载指南）。
- 限制（按账号）：`bandlimin/bandlimout`（bps）、`connlim N 0`（并发）、`countall "<槽位>/<账号>" D|W|M <MB>`（额度），计数持久化在 `/var/lib/aio-proxy/traffic.3cf`；槽位按账号固定，重新部署不会错位。
- 统计读取：3proxy 管理页 `/C`，只监听 127.0.0.1 + 独立随机账号。**注意：`admin -s` 只读模式在 1.0.1 下不显示计数器，因此不使用 `-s`**（实测发现）。
- 到期：`expiry.list` + 每小时定时器 `expire.sh` 过滤生成 `users.active`，变化时 `SIGUSR1` 热重载。
- 重新加载：`systemctl reload` → `SIGUSR1`，配置 `noforce` 保留已认证连接；若重载后监听不完整则完整重启，仍失败则回滚到上一次配置。
- 安装：官方 deb/rpm（解包取二进制，不执行包脚本）→ 官方源码 `make -f Makefile.Linux` → 本机代下载上传；全部按程序内置的官方 SHA256（`threeproxy.Pinned`）校验，不信任下载来的 `SHA256SUMS`（与安装包同一来源，镜像或中间人可一并替换）；镜像只接受 https。官方 deb 使用 zstd 压缩，Debian 11 / Ubuntu 20.04 的 dpkg 无法解包，会自动转为源码编译。

## 14. DNS 方案（调研结论）
- 公共 DNS 的问题：Google 8.8.8.8 与 Quad9 9.9.9.11 会发送 ECS（客户端子网），多段 IP 时会把主 IP 段暴露给权威服务器，导致各段被关联；公共 DNS 还有限流。3proxy 官方高负载指南也明确建议"安装本地递归解析器，不要用公共 DNS"。
- 3proxy 内置解析器：每台上游只问一次、0 条记录即失败、无负缓存，因此需要一个可靠的本地上游。
- **默认：recursive**。unbound 独立实例监听 `127.0.0.1:5335`（避开 53 端口与 systemd-resolved），从根递归，开启 prefetch / serve-expired；3proxy 配置 `nserver 127.0.0.1:5335` 加 `nscache`/`nscache6`。
- 部署自检中，若多数代理"IP 可达但域名失败"（机房封锁 53 出站），自动改为 **forward**（转发到不发送 ECS 的 1.1.1.1 / 9.9.9.9）。
- unbound 无法安装时降级为 **public**（3proxy 直连公共 DNS）。另提供 **system**（系统解析）和 **custom**（自定义）两种选择。
- 客户端须使用 `socks5h://` 或由代理解析域名，否则服务端的 DNS 策略不生效（文档与界面均提示）。

## 15. 验证情况
- Go 单元测试：探测解析、出口探测、CIDR/范围展开、端口/账号分配与冲突、沿用旧账号、3proxy 配置渲染、计数器解析、批量粘贴解析。
- SSH 集成测试：进程内 SSH 服务器，验证登录、上传、环境变量转义、退出码、ANSI 清理、主机密钥变化拒绝与信任更新。
- 3proxy 实测（官方 Windows 版 1.0.1，与 Linux 配置语法一致）：生成的完整配置可加载；账号隔离、无密码拒绝、内网/回环拒绝、`-a` 无转发头、额度截断、限速、计数器读取、auto 同端口双协议，均通过。
- 端到端：`.github/workflows/ci.yml` 在 Ubuntu（systemd）上通过 SSH 部署到本机的 3 个 NAT 地址，验证部署、账号隔离、重新部署沿用账号、测试与卸载；同时覆盖 root 密码与"普通用户 + sudo + 私钥"两种登录方式。
