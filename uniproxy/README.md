# uniproxy

**English** | [中文](#中文)

> [!WARNING]
> **Disclaimer / 免责声明**
>
> **EN** — `uniproxy` is a configuration orchestration tool for self-hosted proxy/edge infrastructure (Xray, sing-box, nginx). It is provided **for personal learning, research and legitimate infrastructure administration only**. You are solely responsible for how you deploy and use it, and for complying with all applicable laws and regulations in your jurisdiction. **Do not use it for any illegal, abusive or unauthorized purpose.** The authors accept no liability for any direct or indirect damage, data loss, service interruption, legal consequence or other harm arising from its use. Use at your own risk. See [DISCLAIMER.md](DISCLAIMER.md).
>
> **中文** — `uniproxy` 是面向自建代理/边缘基础设施（Xray、sing-box、nginx）的配置编排工具，**仅供个人学习、研究与合法的自建基础设施管理使用**。部署与使用方式及其合法性由使用者自行负责，并须遵守所在司法辖区的全部适用法律法规。**严禁用于任何非法、滥用或未经授权的用途。** 作者不对因使用本项目产生的任何直接或间接损失、数据丢失、服务中断、法律后果或其他损害承担责任。使用即表示你已阅读并同意自行承担全部风险。完整条款见 [DISCLAIMER.md](DISCLAIMER.md)。

---

## English

### Overview

`uniproxy` is a zero-dependency Node.js **control plane** that fuses **Xray**, **sing-box** and **nginx** on a single host. One JSON config drives all three: it plans ports, detects conflicts, generates native configs, produces client share links, serves **per-client subscriptions** in three formats, and can install the result with staged validation and rollback.

Version 0.2 adds the operational layer that a panel like [s-ui-x](https://github.com/deposist/s-ui-x) provides: multi-format subscriptions, per-client profiles, transport coverage (HTTPUpgrade, XHTTP), flow safety rules, a pre-flight `doctor` and a guarded `apply`.

### The problem it solves

Running x-ui, s-ui and nginx on one server is easy to install but hard to keep consistent:

1. **Port collisions** — panel ports, inbound ports and nginx 80/443 all compete.
2. **Only one :443** — the website wants it, the proxy wants it too.
3. **Three separate configs** — `config.json` for Xray, another for sing-box, plus `nginx.conf`.
4. **Hand-built links** — change a port and every Reality public key / share link must be recomputed.
5. **Multi-user drift** — links and subscriptions are usually assembled by hand per user.

### Features

- Single source of truth (`config.json`) that generates three native configs.
- Port planner with conflict detection: wildcard overlaps, loopback misuse and :443 clashes are reported.
- **Xray** generator: VLESS / VMess / Trojan; TCP / WS / gRPC / H2 / HTTPUpgrade / XHTTP; TLS / Reality / none.
- **sing-box** generator: same protocol matrix with the transports sing-box supports.
- **nginx** generator with two modes: `http` (nginx owns :443) and `stream` (SNI multiplexing on :443).
- **Per-client subscriptions**: base64 link list, sing-box profile JSON and Clash/Mihomo YAML.
- Reality keypair generation and automatic **public-key derivation** for client links and profiles.
- **Flow safety**: `xtls-rprx-vision` is emitted only for VLESS over TCP with TLS/Reality; elsewhere it is dropped instead of producing an invalid config.
- **`doctor`**: pre-flight diagnostics for placeholders, certificates, Reality keys, duplicate SNI, ports and core binaries.
- **`apply`**: staged validation (`xray run -test`, `sing-box check`, `nginx -t`), timestamped backups, reload commands, automatic restore when a reload fails.
- Read-only web dashboard: port map, checks, links, subscription URLs and config previews.
- Subscription HTTP endpoints with `no-store`, profile headers and per-client tokens.
- Zero runtime dependencies (Node.js >= 18).

### Architecture

```
                 +------------------------------+
                 |        uniproxy (control)     |
                 |  config.json                  |
                 |   +- port planner / checks    |
                 |   +- Xray   config generator  |
                 |   +- sing-box config generator|
                 |   +- nginx  config generator  |
                 |   +- client links/subscriptions|
                 |   +- doctor / apply           |
                 +--------------+---------------+
                                | generate
         +----------------------+----------------------+
         v                      v                      v
     Xray core             sing-box core            nginx
  (panel: x-ui)          (panel: s-ui)        (reverse proxy + SNI)
```

It is an **orchestration layer**, not a replacement for the three programs. Generated configs are the same result you would click out in the panels, but versionable, reproducible and diffable.

### Transports

| Transport | Xray | sing-box | Links | Clash |
|-----------|:----:|:--------:|:-----:|:-----:|
| `tcp` | yes | yes | yes | yes |
| `ws` | yes | yes | yes | yes |
| `grpc` | yes | yes | yes | yes |
| `h2` | yes | yes (`http`) | yes | yes |
| `httpupgrade` | yes (1.8.16+) | yes (1.8+) | yes | recent Mihomo |
| `xhttp` | yes (25.x) | no | yes | skipped |

`uniproxy validate` rejects transports the target core cannot speak; the subscription generators skip what the client cannot import.

### Two nginx modes

| Mode | Owns :443 | Proxy inbounds | When to use |
|------|-----------|----------------|-------------|
| `http` | nginx serves web and panels | separate public ports (e.g. 55555) | Simple, but an HTTPS-looking proxy on a non-443 port is easier to flag |
| `stream` | nginx `stream` routes by **SNI** | bind `127.0.0.1`, reached through :443 | **Recommended** — web, panels, Reality and WS+TLS all share :443 |

Example of the generated :443 multiplexer:

```nginx
stream {
    map $ssl_preread_server_name $uniproxy_backend {
        www.example.com   127.0.0.1:8443;   # website
        xui.example.com   127.0.0.1:8443;   # x-ui panel
        sui.example.com   127.0.0.1:8443;   # s-ui panel
        sub.example.com   127.0.0.1:8443;   # s-ui subscriptions
        www.bing.com      127.0.0.1:10443;  # Xray Reality inbound
        sb.example.com    127.0.0.1:2052;   # sing-box WS+TLS inbound
        default           127.0.0.1:8443;
    }
    server {
        listen 443;
        proxy_pass $uniproxy_backend;
        ssl_preread on;
    }
}
```

### Quickstart

Requirements: Node.js >= 18, no runtime dependencies.

```bash
cd uniproxy
node src/index.js init      -c config.json     # generate a config with fresh keys/UUIDs
node src/index.js validate  -c config.json     # schema + port-conflict check
node src/index.js doctor    -c config.json     # pre-flight checks
node src/index.js generate  -c config.json -o out
node src/index.js links     -c config.json
node src/index.js subscribe -c config.json
node src/index.js serve     -c config.json -p 8787
```

Generated output:

```
out/
  xray/config.json       # feed to: xray -c
  singbox/config.json    # feed to: sing-box -c
  nginx/nginx.conf       # self-contained, works with: nginx -c
  links.txt              # vless:// / vmess:// / trojan://
  sub/<client>-<token>.txt          # base64 link subscription
  sub/<client>-<token>.json         # sing-box client profile
  sub/<client>-<token>.clash.yaml   # Clash / Mihomo profile
  SUMMARY.md             # port map + files + links + subscription URLs
```

### Commands

| Command | Description |
|---------|-------------|
| `init` | create a starter config with generated Reality keypair and UUIDs |
| `validate` | check schema, transports, flow legality and port conflicts |
| `ports` | print the resolved port map |
| `generate` | write xray / sing-box / nginx configs, links and subscriptions |
| `links` | print client share links (`--client`, `--address`, `--json`) |
| `subscribe` | print per-client subscription URLs (`--json`) |
| `doctor` | pre-flight diagnostics (`--json`, `--no-probe`) |
| `apply` | dry-run by default; `--yes` installs and reloads |
| `serve` | start the dashboard and subscription endpoints |

### Subscriptions

Each client of each inbound gets a stable token derived from a hash of the name,
the credential and `server.publicIp`. ``uniproxy serve`` exposes:

| Path | Content-Type | Body |
|------|--------------|------|
| `/sub/<token>` | `text/plain` | base64 link list (v2rayN, NekoBox, Shadowrocket) |
| `/sub/<token>/json` | `application/json` | sing-box client profile (TUN + mixed inbound) |
| `/sub/<token>/clash` | `text/yaml` | Clash / Mihomo profile |

Responses carry `Cache-Control: no-store`, `profile-title` and
`profile-update-interval`. To expose them on your domain, either point an
`nginx.extraSites` entry at the dashboard or the s-ui subscription server:

```json
"nginx": {
  "extraSites": [
    { "serverName": "sub.example.com", "upstream": "127.0.0.1:8787" }
  ]
}
```

A user who exists on both cores (same name and UUID/password) is merged into a
single subscription; `subToken` can be pinned per client in `config.json`.

### Apply safely

```bash
node src/index.js apply -c config.json            # show the plan
node src/index.js apply -c config.json --yes      # validate, install, reload
```

`apply` stages generated configs in a temporary directory, runs the validators
(`xray run -test`, `sing-box check`, `nginx -t`), copies timestamped backups,
writes the targets and runs the reload commands. If a reload fails, the previous
files are restored. Configure paths and commands under `apply`:

```json
"apply": {
  "xrayConfig": "/usr/local/etc/xray/config.json",
  "singboxConfig": "/usr/local/etc/sing-box/config.json",
  "nginxConfig": "/etc/uniproxy/nginx.conf",
  "backup": true,
  "validate": {
    "xray": "xray run -test -c {file}",
    "singbox": "sing-box check -c {file}",
    "nginx": "nginx -t -c {file}"
  },
  "reload": {
    "xray": "systemctl restart xray",
    "singbox": "systemctl restart sing-box",
    "nginx": "systemctl reload nginx"
  }
}
```

### Deploy to Linux

```bash
# install the cores (choose the release that matches your distro)
curl -L https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip -o /tmp/xray.zip
curl -L https://github.com/SagerNet/sing-box/releases/latest/download/sing-box-linux-amd64.tar.gz -o /tmp/sb.tgz
apt install -y nginx

# install generated configs (staged validation + backups)
node src/index.js apply -c config.json --yes

# or copy by hand
cp out/xray/config.json    /usr/local/etc/xray/config.json
cp out/singbox/config.json /usr/local/etc/sing-box/config.json
cp out/nginx/nginx.conf    /etc/uniproxy/nginx.conf
```

### Security notes

- Prefer `stream` mode so proxy traffic also uses :443.
- Use real certificates for TLS; use a real `dest` / `serverNames` for Reality.
- Keep panels on `127.0.0.1` behind nginx and enable a login path prefix.
- Open only 80 and 443 in the firewall.
- Treat subscription URLs as secrets: tokens are unguessable, responses are
  `no-store`, and nginx adds HSTS, `nosniff` and `no-referrer`.

### Credits / reference

Design choices were validated against the [s-ui-x](https://github.com/deposist/s-ui-x)
fork of [alireza0/s-ui](https://github.com/alireza0/s-ui) (a Go panel built on
sing-box). What uniproxy adopted from it:

- the three subscription formats and their response headers;
- per-client subscription identities instead of one global link list;
- stripping `xtls-rprx-vision` when the transport is not plain TCP + TLS;
- verifying the generated config before installing it, with rollback;
- the `doctor` idea: check placeholders, certificates and core binaries first.

uniproxy stays dependency-free and file-based: no database, no embedded core.

### Roadmap

- [x] `apply`: install generated configs with validation and rollback.
- [x] Per-client subscriptions: base64, sing-box JSON, Clash YAML.
- [x] `doctor` pre-flight checks.
- [x] HTTPUpgrade and XHTTP transports.
- [ ] ACME certificate issuance and renewal.
- [ ] x-ui / s-ui API drivers for true one-console control.
- [ ] Editable dashboard.
- [ ] Subscription traffic statistics (needs core stats plumbing).

### License

MIT. See [LICENSE](LICENSE).

---

## 中文

### 这是什么

`uniproxy` 是一个零依赖的 Node.js **控制面**，把 **Xray**、**sing-box**、**nginx** 在同一台服务器上融合起来：一份 JSON 配置同时驱动三者，自动规划端口、检测冲突、生成三套原生配置、输出客户端链接、生成**分客户端订阅**（三种格式），并且可以在校验后安全地下发配置、失败自动回滚。

0.2 版本补齐了 [s-ui-x](https://github.com/deposist/s-ui-x) 这类面板擅长的运维能力：多格式订阅、按客户端生成配置、HTTPUpgrade / XHTTP 传输、flow 合法性规则、`doctor` 预检和带保护的 `apply`。

### 解决什么问题

同机跑 x-ui、s-ui、nginx，装不难，难在保持一致：

1. **端口打架** —— 面板端口、入站端口、nginx 的 80/443 互相抢占；
2. **443 只有一个** —— 网站要，代理也要；
3. **配置三份** —— Xray、sing-box、nginx 各管各的；
4. **链接手工拼** —— 改个端口，Reality 公钥和分享链接全要重算；
5. **多用户难管** —— 每个用户的链接、订阅基本靠手工拼。

### 特性

- 单一配置源（`config.json`）→ 三套原生配置；
- 端口规划与冲突检测（通配符重叠、回环误用、443 冲突都会告警）；
- **Xray** 生成器：VLESS / VMess / Trojan；TCP / WS / gRPC / H2 / HTTPUpgrade / XHTTP；TLS / Reality / none；
- **sing-box** 生成器：同协议矩阵，使用 sing-box 支持的传输；
- **nginx** 生成器：`http`（nginx 独占 443）与 `stream`（443 上按 SNI 分流）两种模式；
- **按客户端订阅**：base64 链接、sing-box 客户端 JSON、Clash/Mihomo YAML 三种格式；
- Reality 密钥对生成 + 客户端公钥自动推导；
- **flow 合法性**：`xtls-rprx-vision` 只在 VLESS + TCP + TLS/Reality 下输出，其它组合自动丢弃，避免生成被内核整体拒绝的配置；
- **`doctor`**：预检占位符、证书、Reality 密钥、重复 SNI、端口和内核二进制；
- **`apply`**：先校验（`xray run -test`、`sing-box check`、`nginx -t`），再备份、下发、reload；reload 失败自动回滚；
- 只读 Web 仪表盘：端口地图、体检、链接、订阅地址与配置预览；
- 订阅接口带 `no-store`、profile 头与按客户端的 token；
- 零运行时依赖（Node.js >= 18）。

### 快速开始

```bash
node src/index.js init      -c config.json
node src/index.js validate  -c config.json
node src/index.js doctor    -c config.json
node src/index.js generate  -c config.json -o out
node src/index.js subscribe -c config.json
node src/index.js serve     -c config.json -p 8787
```

### 订阅

每个客户端一个稳定 token（由名称、凭据和 `server.publicIp` 哈希得到），`serve` 提供：

| 路径 | 内容 |
|------|------|
| `/sub/<token>` | base64 链接列表（v2rayN / NekoBox / Shadowrocket） |
| `/sub/<token>/json` | sing-box 客户端配置（TUN + mixed 入站） |
| `/sub/<token>/clash` | Clash / Mihomo 配置 |

响应带 `Cache-Control: no-store`、`profile-title`、`profile-update-interval`。要放到自己的域名上，给 `nginx.extraSites` 加一条指向仪表盘或 s-ui 订阅端口的记录即可。同一用户（同名同 UUID/密码）跨内核会被合并成一个订阅，也可以在配置里用 `subToken` 固定 token。

### 安全下发

```bash
node src/index.js apply -c config.json          # 只看计划
node src/index.js apply -c config.json --yes    # 校验 + 下发 + reload
```

`apply` 先在临时目录生成配置并跑校验，再生成时间戳备份、写目标文件、执行 reload 命令；任一步失败会恢复旧配置。校验/重载命令可在 `apply.validate` / `apply.reload` 中覆盖。

### 安全提醒

- 优先 `stream` 模式，让代理也走 443；
- TLS 用真实证书，Reality 用真实站点的 `dest` / `serverNames`；
- 面板统一 `127.0.0.1` + nginx 反代；
- 防火墙只放 80/443；
- 订阅地址等同密钥：token 不可枚举、响应 `no-store`，nginx 侧补 HSTS、`nosniff`、`no-referrer`。

### 参考工程

设计与实现参考了 [s-ui-x](https://github.com/deposist/s-ui-x)（Go 编写的 sing-box 面板，`alireza0/s-ui` 的强化分支），主要借鉴其订阅三格式与响应头、按客户端订阅模型、`xtls-rprx-vision` 的传输约束规则、先校验后下发与回滚、以及 `doctor` 预检思路。uniproxy 依然保持零依赖、纯文件配置，不引入数据库或内嵌内核。

### 路线图

- [x] `apply`：校验 + 下发 + 回滚；
- [x] 按客户端订阅（base64 / sing-box / Clash）；
- [x] `doctor` 预检；
- [x] HTTPUpgrade / XHTTP 传输；
- [ ] ACME 证书自动签发与续期；
- [ ] 接 x-ui / s-ui API，实现单控制台；
- [ ] 仪表盘可编辑；
- [ ] 订阅流量统计（需要内核统计链路）。

### 许可证

MIT，见 [LICENSE](LICENSE)。

### 免责声明

完整条款见 [DISCLAIMER.md](DISCLAIMER.md)。要点：本项目仅供个人学习、研究与合法的自建基础设施管理使用；严禁用于任何非法用途；使用风险自负，作者不承担任何责任。
