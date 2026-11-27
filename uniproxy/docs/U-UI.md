# u-ui — uniproxy 管理面板设计

> 目标：把 `uniproxy` 从「命令行 + 只读仪表盘」升级为「可操作的管理面板」，结构参考 3x-ui，信息架构参考 s-ui。

## 1. 借鉴什么

| 来源 | 借鉴点 |
|---|---|
| 3x-ui | 左侧导航（概览 / 用户 / 入站 / 配置 / 操作）、表格 + 弹窗表单、一次性可见的订阅信息、登录页 |
| s-ui | 多格式订阅（links / sing-box / Clash）、内核与服务状态、端口与 TLS 概览、按用户聚合而非按入站聚合 |
| uniproxy 自身 | 单一 `config.json` 作为真相源、`validate` / `doctor` / `apply` 三阶段、443 SNI 复用 |

## 2. 架构

```
浏览器  ──HTTP──▶  u-ui (node:http, 零依赖)
                     │
                     ├─ GET  /            单页应用（原生 JS，无构建）
                     ├─ GET  /api/state   概览 + 端口 + 用户 + 订阅 + 内核状态
                     ├─ CRUD /api/users   用户注册表（写入 config.json）
                     ├─ PUT  /api/config  原始 JSON 编辑（校验后原子写入）
                     └─ POST /api/actions validate / doctor / plan / apply
                     │
                     └─▶ config.json（唯一真相源）
```

u-ui **不接管内核**：它只改 `config.json`，再由 `apply` 下发并 `systemctl` 重启。所以它和 3x-ui / s-ui 不冲突——只要不同时管同一个内核（见 INSTALL 3.0.1）。

## 3. 页面

| 页面 | 内容 |
|---|---|
| 概览 | 配置路径、nginx 模式、公网 IP、端口表、校验结果、入站/用户/订阅计数 |
| 入站 | 表格 + 表单，两套内核共用一套界面：新增/编辑/删除 xray 与 sing-box 入站（协议、监听、端口、网络、TLS/Reality、SNI、WS 路径、Reality 参数）；每个入站可单独管理客户端（凭据留空则按 `server.secret` 派生） |
| 内核 | xray / sing-box / nginx 的运行状态（systemctl），start / stop / restart，以及「是否让 uniproxy 生成该内核配置」的开关 |
| 流量 | 从 Xray stats API 与 sing-box（Clash API）采集按用户的上行/下行，支持一键同步到 `users[].usage`（订阅的 `subscription-userinfo` 随之变化）。生成配置时会**自动开启**统计端点：Xray `stats` + `api`（`xray.apiPort`，默认 10085）、sing-box `experimental.clash_api`（`singbox.clashPort`，默认 9090）；两者都进端口表，可用 `xray.stats: false` / `singbox.clashApi: false` 关闭 |
| 日志 | `journalctl` 查看 xray / sing-box / nginx / uniproxy-sub，可选行数 |
| 设置 | 公网 IP、邮箱、网站域名、证书/私钥路径、80/443/内部 TLS 端口、nginx 模式、两个面板的域名与端口 |
| 用户 | 表格（状态/到期/配额/入站/订阅 token）+ 新增/编辑/删除 |
| 配置 | `config.json` 原始文本编辑器，保存前跑 `validate`，写入前自动备份 |
| 操作 | `validate` / `doctor` / `plan`（只预览）/ `apply`（需输入确认词） |

## 4. API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 应用页面（未登录跳 `/login`） |
| GET/POST | `/login`、`/logout` | 密码登录，会话 Cookie |
| GET | `/api/state` | 概览数据（含 CSRF token） |
| GET | `/api/config` | 原始配置文本 |
| PUT | `/api/config` | 保存配置（校验 + 备份 + 原子写） |
| POST | `/api/users` | 新增用户 |
| PUT | `/api/users/:name` | 修改用户 |
| DELETE | `/api/users/:name` | 删除用户 |
| GET/POST | `/api/inbounds` | 列出 / 新增入站（`kind` 为 `xray` 或 `singbox`） |
| PUT/DELETE | `/api/inbounds/:kind/:tag` | 修改 / 删除入站 |
| GET | `/api/cores` | 三个内核与服务的状态、是否生成配置 |
| POST | `/api/cores/:kind/:action` | `start` `stop` `restart` |
| PUT | `/api/cores/:kind` | `{ enabled: false }` 关掉该内核的配置生成 |
| GET/POST | `/api/inbounds/:kind/:tag/clients` | 列出 / 新增该入站的客户端 |
| DELETE | `/api/inbounds/:kind/:tag/clients/:name` | 删除客户端 |
| GET | `/api/stats` | 采集后的按用户流量 |
| POST | `/api/stats/sync` | 把流量写回 `users[].usage` |
| GET | `/api/logs?unit=&lines=` | journalctl 日志 |
| GET/PUT | `/api/settings` | 读取 / 保存常用设置 |
| POST | `/api/actions/:action` | `validate` `doctor` `plan` `apply` |

所有非 GET 请求必须带 `x-uui-csrf` 头，值与 `uui_csrf` Cookie 相同（双提交）。

## 5. 安全

- 默认只监听 `127.0.0.1`；远程访问请用 SSH 隧道或 nginx 反代 + HTTPS。
- 启动必须配置密码：环境变量 `UNIPROXY_UI_PASSWORD`，或 `config.json` 的 `ui.password`；没有密码直接拒绝启动。
- 会话 = `exp` + HMAC-SHA256（密钥由密码与 `server.secret` 派生），HttpOnly + SameSite=Strict。
- 登录失败按来源 IP 限速（简单内存计数）。
- `apply` 必须显式输入确认词，避免误点。
- 配置写入前先校验，写入时生成 `.bak-<时间戳>` 备份并原子替换。

## 6. 数据模型

用户对象（`config.json` 的 `users[]`）：

```json
{
  "name": "alice",
  "inbounds": ["xray-vless-reality", "sb-vless-ws-tls"],
  "expireAt": "2027-01-01T00:00:00Z",
  "dataLimitBytes": 107374182400,
  "enabled": true,
  "note": "team A"
}
```

凭据由 `server.secret` 确定性派生（同名用户重复生成不会变 UUID），u-ui 只负责注册表本身。

## 7. 阶段

- **已完成**：登录、概览、入站 CRUD（xray + sing-box）、**入站级客户端管理**、用户 CRUD、内核启停与开关、**流量采集与同步**、**日志查看**、**设置表单**、原始配置编辑、四个操作按钮。
- 后续：内核拓扑图、审计日志、多用户角色。
  