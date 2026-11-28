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
| nginx | 模式切换（stream/http）；站点可填本机根目录或反代 URL（可选改写页面域名）；按域名/路径的 locations 反代（精确匹配、WebSocket）；探测流量回落博客；extraSites；SNI 路由预览、生成配置预览、`nginx -t` 与 reload |
| 拓扑 | 从 443 入口按 SNI 到各后端的流向，以及全部监听端口 |
| 节点 | 注册其他服务器（ssh/scp，无需 agent），带 `group` 分组；支持全部探测、按分组批量下发；下发前先比较远端 `sha256sum`，一致则跳过（增量同步） |
| 审计 | 每次配置写入、apply、内核操作、nginx 测试/重载的时间与动作 |
| 告警 | 汇总 doctor 发现、端口冲突、内核未运行；配置 webhook / 命令通道，按冷却时间推送（`uniproxy alerts --notify` 亦可） |
| 证书 | 查看当前证书（subject/issuer/到期/SANs）；用 certbot 或 acme.sh 申请与续期，支持 webroot / standalone / DNS-01，可选 staging；命令以 argv 方式执行，不拼 shell |
| 备份 | 列出自动备份（每次写配置都会生成 `.bak-<时间戳>`）与手动备份，可下载、恢复、删除；恢复前先校验并自动备份当前版本；支持粘贴 JSON 导入；**保留策略** `backups.keep`（默认 20，0 = 不清理）每次写入后自动裁剪 |
| 账号 | 管理员增删改面板账号（管理员/只读）、重置密码；密码以 scrypt 哈希保存，删除/降级最后一个管理员会被拒绝 |
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
| GET/PUT | `/api/nginx` | 读取（含生成预览与 SNI 路由）/ 保存站点与反代 |
| POST | `/api/nginx/test` | 用 `apply.validate.nginx` 跑 `nginx -t` |
| POST | `/api/nginx/reload` | 用 `apply.reload.nginx` 重载 |
| GET | `/api/audit?limit=` | 审计日志（JSONL 尾读） |
| GET | `/api/alerts` | 当前告警与通道状态 |
| POST | `/api/alerts/notify` | 推送到期告警（遵守冷却） |
| GET/PUT | `/api/certs` | 证书状态、申请配置与计划命令 / 保存申请配置 |
| POST | `/api/certs/issue` | 申请证书 |
| POST | `/api/certs/renew` | 续期 |
| GET/POST | `/api/nodes` | 列出 / 新增节点 |
| PUT/DELETE | `/api/nodes/:id` | 修改 / 删除节点 |
| POST | `/api/nodes/:id/probe` | ssh 探测远端内核状态 |
| POST | `/api/nodes/:id/deploy` | scp 配置并远端 `apply --yes` |
| POST | `/api/nodes/probe-all` | 批量探测全部节点 |
| POST | `/api/nodes/deploy-all` | 按 `group` 或 `ids` 批量下发，`force: true` 可跳过增量判断 |
| GET/POST | `/api/backups` | 列出备份 / 立即备份 |
| GET | `/api/backups/:name/download` | 下载备份文件 |
| POST | `/api/backups/:name/restore` | 校验后恢复（先自动备份当前版本） |
| DELETE | `/api/backups/:name` | 删除备份 |
| GET/POST | `/api/accounts` | 列出 / 新增账号（仅管理员） |
| PUT/DELETE | `/api/accounts/:username` | 改密码或角色 / 删除账号 |
| POST | `/api/actions/:action` | `validate` `doctor` `plan` `apply` |

所有非 GET 请求必须带 `x-uui-csrf` 头，值与 `uui_csrf` Cookie 相同（双提交）。

## 5. 安全

- 默认只监听 `127.0.0.1`；远程访问请用 SSH 隧道或 nginx 反代 + HTTPS。
- 启动必须配置密码：环境变量 `UNIPROXY_UI_PASSWORD`，或 `config.json` 的 `ui.password`；没有密码直接拒绝启动。
- 会话 = `exp` + HMAC-SHA256（密钥由密码与 `server.secret` 派生），HttpOnly + SameSite=Strict。
- 登录失败按来源 IP 限速（简单内存计数）。
- 账号体系：`ui.users` 保存 `用户名 + scrypt 哈希 + 角色`。管理员可增删改账号、重置密码；只读账号所有写操作返回 403，界面按钮置灰。至少要保留一个管理员（删/降级最后一个管理员会被拒绝）。旧的 `ui.password` / `ui.viewerPassword` 仍兼容：没有 `ui.users` 时退化为单密码模式。
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

- **已完成**：登录与双角色、概览、入站 CRUD（xray + sing-box）、入站级客户端、用户 CRUD、内核启停与开关、流量采集与同步、日志查看、nginx 站点/反代管理与测试重载、拓扑视图、审计日志、告警与通知、**证书申请与续期**、设置表单、原始配置编辑、四个操作按钮。
- 后续：更细的权限矩阵、告警静默窗口、多通道分组。
## 8. 协议矩阵

面板不先问「xray 还是 sing-box」，而是先选协议，由 `src/protocols.js` 决定可用内核、传输与安全方式：

| 协议 | 内核 | 传输 | 安全 |
|---|---|---|---|
| vless | xray / singbox | tcp, ws, grpc, h2 | none, tls, reality |
| vmess | xray / singbox | tcp, ws, grpc, h2 | none, tls |
| trojan | xray / singbox | tcp, ws, grpc | tls |
| shadowsocks | xray / singbox | tcp | none |
| socks / http | xray / singbox | tcp | none |
| hysteria2 | singbox | quic | tls |
| tuic | singbox | quic | tls |

后端按同一张表校验，非法组合（例如用 xray 承载 hysteria2）会直接报错，不依赖前端过滤。

  
## 9. 终端菜单

除了网页面板，服务器上直接敲 **`u-ui`**（或 `uniproxy menu`，无参数在 TTY 下也会进入）就打开 3x-ui 风格的终端菜单：

| 分区 | 动作 |
|---|---|
| 面板 | 查看设置、改面板端口、**修改访问路径（webBasePath）**、重置管理员/只读密码 |
| 服务 | **安装/卸载 systemd 单元**（`uniproxy-ui` + `uniproxy-sub`）、启动/停止/重启、状态（所有 unit 的完整 systemctl status）、日志（可选 u-ui/订阅/xray/sing-box/nginx）、开机自启 |
| 配置 | validate、doctor、apply、立即备份、恢复备份 |
| 内核 | 重启 / 停止 / 启动 xray、sing-box、nginx；**安装/升级/卸载 xray、sing-box** |
| 其他 | 证书状态、申请/续期、告警、节点列表、探测流量回落博客 |

菜单底部实时显示面板与三个内核的状态，所有动作复用同一套 CLI 函数，不会和网页面板行为分叉。

## 9.1 证书申请

菜单申请/续期证书时，如果系统没有 `certbot`，会先询问并自动用 apt/dnf/yum/apk/zypper 安装，再执行申请；`standalone` 验证会临时停止 nginx、申请完成后自动启动，`webroot` 验证保持 nginx 运行。

## 9.2 探测流量回落到博客

未知 SNI、直接访问 IP:443 的探测流量会进入 nginx 的默认 TLS server。想让它显示博客而不是 u-ui 面板，配置 `nginx.fallback`：

外站博客：

```json
"nginx": {
  "fallback": { "upstream": "https://blog.example.com" }
}
```

本机静态博客：

```json
"nginx": { "fallback": { "root": "/var/www/blog" } }
```

本机其他端口：

```json
"nginx": { "fallback": { "upstream": "http://127.0.0.1:8080" } }
```

也可以不用手改配置：菜单 `41` 直接输入博客 URL 或本机绝对目录，`-` 关闭，回车保留；保存后菜单 19 validate、21 apply。已知域名（站点、u-ui、订阅）仍按各自 vhost 处理；只有未知域名/无 SNI/直接 IP 会落到 fallback。HTTP 80 仍先 301 到 HTTPS。

## 9.3 从旧 nginx 配置迁移

旧配置里的单域名 path 分流，对应到 u-ui 的 nginx 页：

| 旧配置 | u-ui 设置 |
|---|---|
| `location / { proxy_pass https://blog...; }` | 站点行填 `https://blog...`（根目录/反代 URL），勾选“改写域名” |
| `location = /xray { ... Upgrade ... }` | 路径反代：域名、`/xray`、后端 `127.0.0.1:55555`，勾选“精确”和“WebSocket” |
| `location ^~ /managerxui/` | 路径反代：路径 `/managerxui/`，后端 `127.0.0.1:30580` |
| `location ^~ /managersui/` | 路径反代：路径 `/managersui/`，后端 `127.0.0.1:2095` |
| 整个 server 的 `sub_filter` | 站点行勾选“改写域名” |
| 未匹配域名回落博客 | “探测回落博客”输入 `https://blog...`，或菜单 41 |

保存只会写入 `config.json`。要让配置真正进入 `/etc/nginx/nginx.conf`，还需要菜单 21 apply，或在 u-ui「操作」页执行 apply；之后再用 nginx -t / reload。

## 10. 初始化向导

`u-ui` 菜单的 **3. 初始化向导**（或 `uniproxy setup`）只问你真正需要决定的东西，其余全部随机：

| 项 | 能否随机 | 默认 | 说明 |
|---|---|---|---|
| 域名 | ❌ 必须你提供，或跳过走仅 IP | 无 | 决定证书、网站 server_name、SNI 分流 |
| u-ui 域名 | ✅ `r` 随机前缀，`-` 跳过 | `uui.<域名>` | 面板访问地址；自动写入证书 SAN |
| u-ui 访问路径 | ✅ 任意前缀，如 `/uui/` | `/` | 页面、登录和 API 都挂在该前缀下 |
| 订阅公开地址 | ✅ 可留空自动，`-` 清空 | `http://公网IP:端口` | 订阅链接的基地址；只填域名会自动补 `https://`，该域名会加入证书 SAN 并由 nginx 反代 |
| 公网 IP | 自动探测，可覆盖 | 探测结果 | 用于生成客户端链接 |
| 面板端口 | ✅ 输入 `r` 随机 | 8788 | |
| 订阅端口 | ✅ 输入 `r` 随机 | 8787 | |
| 管理员密码 | ✅ `r` 随机；首次安装回车随机 | 保留已有密码 | 已存在管理员时回车不变，输入新密码才更新 |
| 只读密码 | ✅ 回车=不设置，`r`=随机 | 不设置 | |
| 邮箱 | ❌ 需你提供，可跳过 | 无 | 仅申请证书时用到 |
| `server.secret` | ✅ 自动 | 随机 | 所有凭据都由它派生 |
| VLESS UUID / Reality 密钥 / shortId / 用户 UUID | ✅ 自动 | 随机 | |

初始化只创建**一个管理员账号**（用户名 + 密码），其他账号在面板「账号」页添加。需要校验的输入（域名、IP、端口、邮箱、订阅地址、访问路径）不合法时会提示并重新询问，不会跳到下一项。**重复运行向导时回车保留当前值**，只有重新输入的项才会更新；没有配置文件时自动生成一份默认配置。向导不再配置 x-ui / s-ui 面板反代（默认 `panels.xui.enabled=false`、`panels.sui.enabled=false`）；需要时可在 `config.json` 里手动打开。非交互用法：`uniproxy setup --yes --domain example.com --username admin --password '...' --email a@b.c`。