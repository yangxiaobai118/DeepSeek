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

`uniproxy` is a zero-dependency Node.js **control plane** that fuses **Xray**, **sing-box** and **nginx** on a single host. One JSON config drives all three: it plans ports, detects conflicts, generates native configs, produces client share links, and can multiplex :443 across services using SNI.

### The problem it solves

Running x-ui, s-ui and nginx on one server is easy to install but hard to keep consistent:

1. **Port collisions** — panel ports, inbound ports and nginx 80/443 all compete.
2. **Only one :443** — the website wants it, the proxy wants it too.
3. **Three separate configs** — `config.json` for Xray, another for sing-box, plus `nginx.conf`.
4. **Hand-built links** — change a port and every Reality public key / share link must be recomputed.

### Features

- Single source of truth (`config.json`) that generates three native configs.
- Port planner with conflict detection: wildcard overlaps, loopback misuse and :443 clashes are reported.
- **Xray** generator: VLESS / VMess / Trojan; TCP / WS / gRPC / h2; TLS / Reality / none.
- **sing-box** generator: same protocol matrix.
- **nginx** generator with two modes: `http` (nginx owns :443) and `stream` (SNI multiplexing on :443).
- **Reality keypair generation** and automatic **public-key derivation** for client links.
- Client share links (`vless://`, `vmess://`, `trojan://`) ready for v2rayN / NekoBox.
- Read-only web dashboard: port map, checks, links and config previews.
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
                 |   +- client link generator    |
                 +--------------+---------------+
                                | generate
         +----------------------+----------------------+
         v                      v                      v
     Xray core             sing-box core            nginx
  (panel: x-ui)          (panel: s-ui)        (reverse proxy + SNI)
```

It is an **orchestration layer**, not a replacement for the three programs. The MVP generates standalone native configs — the same result you would click out in the panels, but versionable, reproducible and diffable.

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
node src/index.js generate  -c config.json -o out
node src/index.js links     -c config.json
node src/index.js serve     -c config.json -p 8787
```

Generated output:

```
out/
  xray/config.json       # feed to: xray -c
  singbox/config.json    # feed to: sing-box -c
  nginx/nginx.conf       # self-contained, works with: nginx -c
  links.txt              # vless:// / vmess:// / trojan://
  SUMMARY.md             # port map + file list + links
```

### Commands

| Command | Description |
|---------|-------------|
| `init` | create a starter config with generated Reality keypair and UUIDs |
| `validate` | check schema and port conflicts |
| `ports` | print the resolved port map |
| `generate` | write xray / sing-box / nginx configs plus links |
| `links` | print client share links |
| `serve` | start the read-only dashboard |

### Deploy to Linux

```bash
# install the cores (choose the release that matches your distro)
curl -L https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip -o /tmp/xray.zip
curl -L https://github.com/SagerNet/sing-box/releases/latest/download/sing-box-linux-amd64.tar.gz -o /tmp/sb.tgz
apt install -y nginx

# place the generated configs
cp out/xray/config.json    /usr/local/etc/xray/config.json
cp out/singbox/config.json /usr/local/etc/sing-box/config.json
cp out/nginx/nginx.conf    /etc/uniproxy/nginx.conf

# validate and start
xray run -test -c /usr/local/etc/xray/config.json
sing-box check -c /usr/local/etc/sing-box/config.json
nginx -t -c /etc/uniproxy/nginx.conf
```

### Security notes

- Prefer `stream` mode so proxy traffic also uses :443.
- Use real certificates for TLS; use a real `dest` / `serverNames` for Reality.
- Keep panels on `127.0.0.1` behind nginx and enable a login path prefix.
- Open only 80 and 443 in the firewall.

### Roadmap

- [ ] `apply`: reload systemd services after generation.
- [ ] ACME certificate issuance and renewal.
- [ ] x-ui / s-ui API drivers for true one-console control.
- [ ] Editable dashboard.
- [ ] Subscription output (base64 / Clash / sing-box).

### License

MIT. See [LICENSE](LICENSE).

---

## 中文

### 这是什么

`uniproxy` 是一个零依赖的 Node.js **控制面**，把 **Xray**、**sing-box**、**nginx** 在同一台服务器上融合起来：一份 JSON 配置同时驱动三者，自动规划端口、检测冲突、生成三套原生配置、输出客户端链接，并可用 SNI 让多个服务共享 443。

### 解决什么问题

同机跑 x-ui、s-ui、nginx，装不难，难在保持一致：

1. **端口打架** —— 面板端口、入站端口、nginx 的 80/443 互相抢占；
2. **443 只有一个** —— 网站要，代理也要；
3. **配置三份** —— Xray、sing-box、nginx 各管各的；
4. **链接手工拼** —— 改个端口，Reality 公钥和分享链接全要重算。

### 特性

- 单一配置源（`config.json`）→ 三套原生配置；
- 端口规划与冲突检测（通配符重叠、回环误用、443 冲突都会告警）；
- **Xray** 生成器：VLESS / VMess / Trojan；TCP / WS / gRPC / h2；TLS / Reality / none；
- **sing-box** 生成器：同协议矩阵；
- **nginx** 生成器：`http`（nginx 独占 443）与 `stream`（443 上按 SNI 分流）两种模式；
- Reality 密钥对生成 + 客户端公钥自动推导；
- 客户端分享链接（`vless://` / `vmess://` / `trojan://`），可直接导入 v2rayN / NekoBox；
- 只读 Web 仪表盘：端口地图、体检、链接与配置预览；
- 零运行时依赖（Node.js >= 18）。

### 架构

与上文英文部分的架构图一致：控制面读取一份配置，分别生成 Xray、sing-box、nginx 三套原生配置。

### 两种 nginx 模式

| 模式 | 谁占 443 | 代理入站 | 适用 |
|------|---------|---------|------|
| `http` | nginx 服务网站与面板 | 独立公网端口（如 55555） | 简单；但伪装 HTTPS 却不在 443 端口，更易被端口启发式标记 |
| `stream` | nginx `stream` 按 **SNI** 分流 | 绑定 `127.0.0.1`，经 :443 进入 | **推荐**——网站、面板、Reality、WS+TLS 全共享 :443 |

### 快速开始

要求：Node.js >= 18，零运行时依赖。

```bash
cd uniproxy
node src/index.js init      -c config.json
node src/index.js validate  -c config.json
node src/index.js generate  -c config.json -o out
node src/index.js links     -c config.json
node src/index.js serve     -c config.json -p 8787
```

### 命令

| 命令 | 说明 |
|------|------|
| `init` | 生成带真实 Reality 密钥与 UUID 的初始配置 |
| `validate` | 校验配置结构与端口冲突 |
| `ports` | 打印最终端口地图 |
| `generate` | 生成 xray / sing-box / nginx 配置与链接 |
| `links` | 打印客户端分享链接 |
| `serve` | 启动只读仪表盘 |

### 部署到 Linux

```bash
# 安装内核（按发行版选择对应 release）
curl -L https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip -o /tmp/xray.zip
curl -L https://github.com/SagerNet/sing-box/releases/latest/download/sing-box-linux-amd64.tar.gz -o /tmp/sb.tgz
apt install -y nginx

# 布置配置
cp out/xray/config.json    /usr/local/etc/xray/config.json
cp out/singbox/config.json /usr/local/etc/sing-box/config.json
cp out/nginx/nginx.conf    /etc/uniproxy/nginx.conf

# 校验并启动
xray run -test -c /usr/local/etc/xray/config.json
sing-box check -c /usr/local/etc/sing-box/config.json
nginx -t -c /etc/uniproxy/nginx.conf
```

### 安全提醒

- 优先 `stream` 模式，让代理也走 443；
- TLS 用真实证书，Reality 用真实站点的 `dest` / `serverNames`；
- 面板统一 `127.0.0.1` + nginx 反代，并开启登录路径前缀；
- 防火墙只放 80/443。

### 路线图

- [ ] `apply`：生成后自动 reload systemd 服务；
- [ ] 接入 ACME，自动签发与续期证书；
- [ ] 接 x-ui / s-ui 的 API，实现真正的单控制台；
- [ ] 仪表盘升级为可编辑；
- [ ] 订阅输出（base64 / Clash / sing-box）。

### 许可证

MIT，见 [LICENSE](LICENSE)。

### 免责声明

完整条款见 [DISCLAIMER.md](DISCLAIMER.md)。要点：本项目仅供个人学习、研究与合法的自建基础设施管理使用；严禁用于任何非法用途；使用风险自负，作者不承担任何责任。
