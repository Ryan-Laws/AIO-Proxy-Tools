# 本地 HTTP API

后端只监听 `127.0.0.1`。所有 `/api/*` 请求必须带令牌：请求头 `X-Token: <token>`，或查询参数 `?t=<token>`（SSE 用）。
令牌来自启动时打开的页面地址 `/?t=<token>`，前端读取后保存在 `sessionStorage`。

数据结构见 `internal/model/*.go`（字段名即 JSON 名）。前端对应类型在 `web/src/api/types.ts`。

错误统一返回：HTTP 4xx/5xx + `{"error":"中文错误信息"}`。

## 元信息与偏好
| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/meta` | – | `{version, vault:{exists,unlocked}, defaults: Settings, prefs: Preferences}` |
| PUT | `/api/prefs` | `Preferences` | `Preferences` |

## 加密保险箱（记住密码，可选）
| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/api/vault/create` | `{password}` | `{exists,unlocked}` |
| POST | `/api/vault/unlock` | `{password}` | `{exists,unlocked}`（解锁后自动填回已保存服务器的凭据） |
| POST | `/api/vault/lock` | – | `{exists,unlocked}` |
| POST | `/api/vault/reset` | – | 删除保险箱 |

## 服务器
| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/servers` | – | `ServerView[]` |
| POST | `/api/servers` | `{servers: ServerInput[]}` | `ServerView[]` |
| POST | `/api/servers/parse` | `{text, defaults:{port,user,authType}}` | `{servers: ServerInput[], errors: string[]}` 批量粘贴解析 |
| PATCH | `/api/servers/{id}` | `ServerInput`（密码留空=不修改） | `ServerView` |
| DELETE | `/api/servers/{id}` | – | `{}` |
| PUT | `/api/servers/{id}/selected` | `{selected: string[]}` | `ServerView` |

## 服务器操作（均返回 `{taskId}`，进度通过 SSE 推送）
| 路径 | 请求 | 说明 |
|---|---|---|
| POST `/api/servers/{id}/detect` | `{trustNewKey?: bool}` | 连接 + 探测 + 出口探测 + 读取已部署清单 |
| POST `/api/servers/{id}/probe` | `{addrs: string[], bind: bool}` | 手动添加 IP/CIDR/范围 并探测 |
| POST `/api/servers/{id}/deploy` | `PlanRequest` | 部署 |
| POST `/api/servers/{id}/test` | `{where: "local"\|"server"\|"both"}` | 测试已部署代理 |
| POST `/api/servers/{id}/refresh` | – | 读取清单、服务状态、流量统计 |
| POST `/api/servers/{id}/service` | `{action: "start"\|"stop"\|"restart"}` | 服务控制 |
| POST `/api/servers/{id}/uninstall` | – | 卸载 |
| POST `/api/servers/{id}/plan` | `PlanRequest` | **同步**返回 `PlanResult`（预览，不执行） |

## 批量
| 路径 | 请求 | 响应 |
|---|---|---|
| POST `/api/batch` | `{action: "detect"\|"deploy"\|"test"\|"refresh", ids: string[], settings?: Settings}` | `{taskIds: {serverId: taskId}}` |

批量部署时每台服务器使用自己的 `selected`；为空则自动选择所有"出口探测成功"的 IP。

## 任务
| 方法 | 路径 | 响应 |
|---|---|---|
| GET | `/api/tasks/{id}` | `TaskView`（含全部日志） |
| POST | `/api/tasks/{id}/cancel` | `{}` |

## 事件流（SSE）
`GET /api/events?t=<token>`，每条 `data:` 为一个 `Event` JSON：
- `{type:"server", server}`：服务器状态变化（整条替换）
- `{type:"server-removed", id}`
- `{type:"task", task}`：任务状态/进度变化（不含 logs）
- `{type:"log", id: taskId, log}`：任务新日志行

连接建立时先推送全部服务器与运行中任务的快照。
