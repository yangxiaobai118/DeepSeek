# uniproxy

Unified control plane for **Xray + sing-box + nginx** on one host. One JSON config drives all three: port planning, native config generation, :443 SNI multiplexing, per-client subscriptions, and a built-in **u-ui** management panel.

[Latest release](https://github.com/yangxiaobai118/DeepSeek/releases) · [Install guide](uniproxy/docs/INSTALL.md) · [中文手册](uniproxy/docs/INSTALL.zh-CN.md) · [u-ui panel](uniproxy/docs/U-UI.md)

> **Disclaimer:** for personal learning, research and lawful self-hosted infrastructure only. Do not use it for illegal or abusive purposes. See [DISCLAIMER.md](uniproxy/DISCLAIMER.md).

---

## Quick Start

### One-line install (recommended)

Requirements: Linux with systemd, root access, TCP **80/443** open.

```bash
bash <(curl -Ls https://raw.githubusercontent.com/yangxiaobai118/DeepSeek/feature/uniproxy/uniproxy/install.sh)
```

The installer detects the architecture, downloads the matching release asset (self-contained binary when available, otherwise the Node bundle), installs `uniproxy` / `u-ui`, writes `/etc/uniproxy/config.json` and the two systemd units, and starts the panel.

**Pin a version** (append the tag number):

```bash
bash <(curl -Ls https://raw.githubusercontent.com/yangxiaobai118/DeepSeek/feature/uniproxy/uniproxy/install.sh) 0.4.6
```

**Dry run** — print the plan without touching the system:

```bash
UNIPROXY_DRY_RUN=1 bash <(curl -Ls https://raw.githubusercontent.com/yangxiaobai118/DeepSeek/feature/uniproxy/uniproxy/install.sh)
```

**Custom ports / paths**:

```bash
UNIPROXY_UI_PORT=9000 UNIPROXY_SUB_PORT=9001 UNIPROXY_PREFIX=/opt/uniproxy \
  bash <(curl -Ls https://raw.githubusercontent.com/yangxiaobai118/DeepSeek/feature/uniproxy/uniproxy/install.sh)
```

Other overrides: `UNIPROXY_VERSION`, `UNIPROXY_BIN_DIR`, `UNIPROXY_ETC_DIR`, `UNIPROXY_REPO`.

### After install

| Item | Value |
|------|-------|
| Menu | run `u-ui` (also opens automatically on a TTY) |
| Panel | `http://127.0.0.1:8788` — tunnel with `ssh -L 8788:127.0.0.1:8788 root@<server>` |
| Config | `/etc/uniproxy/config.json` |
| Services | `uniproxy-ui.service`, `uniproxy-sub.service` |

In the menu choose **Setup wizard** (domain, ports, admin password — Enter keeps random values), then **validate** and **apply**. The wizard writes an admin account; u-ui never stores plaintext passwords.

<details>
<summary><b>Manual install (binary or npm)</b></summary>

```bash
# self-contained binary
curl -fLO https://github.com/yangxiaobai118/DeepSeek/releases/download/uniproxy-v0.4.6/uniproxy-0.4.6-linux-x64
install -m 0755 uniproxy-0.4.6-linux-x64 /usr/local/bin/uniproxy

# or the npm package (needs Node.js >= 18)
npm install -g https://github.com/yangxiaobai118/DeepSeek/releases/download/uniproxy-v0.4.6/uniproxy-0.4.6.tgz

uniproxy init -c /etc/uniproxy/config.json
uniproxy setup -c /etc/uniproxy/config.json --yes
uniproxy validate -c /etc/uniproxy/config.json
uniproxy apply -c /etc/uniproxy/config.json --yes
```

See the [install guide](uniproxy/docs/INSTALL.md) for certificates, systemd units and everything else.

</details>

---

## Features

- **Single source of truth** — one `config.json` generates Xray, sing-box and nginx configurations that are versionable and diffable.
- **Port planner** — wildcard overlaps, loopback misuse and :443 clashes are reported before anything is written.
- **Protocols & transports** — VLESS / VMess / Trojan; TCP / WS / gRPC / H2 / HTTPUpgrade / XHTTP; TLS / Reality / none.
- **One :443** — nginx `stream` multiplexes by SNI (web, panels, Reality, WS+TLS), or `http` mode if you prefer nginx to own TLS.
- **Users, quotas, subscriptions** — a registry user can span both cores; per-user expiry/quota; base64, sing-box JSON and Clash/Mihomo subscriptions with `subscription-userinfo`.
- **u-ui panel** — login (admin/viewer, scrypt hashes), inbounds and clients, users, cores, traffic stats, logs, nginx sites, topology, nodes, audit, alerts, certificates, backups, config editor and actions.
- **Safe apply** — staged validation (`xray run -test`, `sing-box check`, `nginx -t`), timestamped backups, reload, automatic rollback when a reload fails.
- **Operations** — `doctor` pre-flight checks, `setup` wizard, 3x-ui style terminal `menu`, one-line installer, node groups with batch probe/deploy and incremental sync.
- **Zero dependencies** — pure Node.js >= 18; self-contained single-file binaries (Node SEA) for common platforms.

## u-ui panel

`u-ui` (or `uniproxy ui`) starts a web panel bound to `127.0.0.1:8788` by default:

| Page | What it does |
|------|--------------|
| Overview | config path, mode, port map, checks, inbound/user/subscription counts |
| Inbounds | add/edit/delete Xray and sing-box inbounds; per-inbound clients |
| Users | registry users, status, quota, expiry, subscription token |
| Cores | start/stop/restart xray, sing-box, nginx; toggle config generation |
| Traffic | Xray stats + sing-box Clash API, sync usage into users |
| Logs / Alerts | journalctl views; alert rules with webhook or command channels |
| nginx / Topology | sites and reverse proxies, `nginx -t`, SNI flow view |
| Nodes | SSH-based remote servers, groups, batch probe/deploy |
| Certs / Backups | certbot/acme.sh issuance and renewal; backup/restore with retention |
| Settings / Config / Actions | form settings, raw JSON editor, validate / doctor / plan / apply |

Design and API notes: [u-ui panel](uniproxy/docs/U-UI.md).

## Supported platforms

| Platform | Architecture | Self-contained binary | JS bundle (Node >= 18) |
|----------|--------------|:---------------------:|:----------------------:|
| Linux | x86_64, arm64, ppc64le, s390x, musl x64 | ✅ | ✅ |
| Linux | i386, armv7l, armv6l | — | ✅ |
| Windows | x64, arm64 | ✅ | ✅ |
| Windows | x86 | — | ✅ |
| macOS | x64, arm64 | ✅ | ✅ |
| Any | — | — | ✅ npm `uniproxy-<version>.tgz` |

Binaries are Node.js SEA builds (glibc >= 2.28 on Linux, ad-hoc signed on macOS). Every release also ships each archive with a companion `.sha256`.

## CLI

| Command | Description |
|---------|-------------|
| `u-ui` / `uniproxy menu` | terminal menu (3x-ui style); bare `uniproxy` opens it on a TTY |
| `uniproxy setup` | first-run wizard (domain, IP, ports, admin password) |
| `uniproxy ui` | u-ui management panel |
| `uniproxy validate` | schema, transport, flow legality and port conflicts |
| `uniproxy doctor` | pre-flight diagnostics (certificates, keys, cores, users) |
| `uniproxy generate` | write Xray / sing-box / nginx configs, links, subscriptions |
| `uniproxy apply` | dry-run by default; `--yes` validates, backs up, installs and reloads |
| `uniproxy links` / `subscribe` | client links and subscription URLs |
| `uniproxy users` / `alerts` | user registry; alert collection and notification |
| `uniproxy serve` | subscription/dashboard HTTP server |
| `uniproxy ports` / `init` | port map; starter config with fresh secrets |

## Documentation

- [Installation & deployment guide (English)](uniproxy/docs/INSTALL.md)
- [安装与部署手册（中文）](uniproxy/docs/INSTALL.zh-CN.md)
- [u-ui panel design and API](uniproxy/docs/U-UI.md)
- [Changelog](uniproxy/CHANGELOG.md)
- [Disclaimer](uniproxy/DISCLAIMER.md) · [License (MIT)](uniproxy/LICENSE)

## 中文快速开始

要求：Linux + systemd、root、放行 80/443。一条命令安装（自动识别架构、写入 systemd 单元并启动面板）：

```bash
bash <(curl -Ls https://raw.githubusercontent.com/yangxiaobai118/DeepSeek/feature/uniproxy/uniproxy/install.sh)
```

固定版本 / 仅预览：

```bash
bash <(curl -Ls https://raw.githubusercontent.com/yangxiaobai118/DeepSeek/feature/uniproxy/uniproxy/install.sh) 0.4.6
UNIPROXY_DRY_RUN=1 bash <(curl -Ls https://raw.githubusercontent.com/yangxiaobai118/DeepSeek/feature/uniproxy/uniproxy/install.sh)
```

装完执行 `u-ui` 打开菜单，选「初始化向导」填入域名/端口/管理员密码，再依次 validate、apply；面板地址 `http://127.0.0.1:8788`（建议 SSH 隧道）。详见 [中文安装手册](uniproxy/docs/INSTALL.zh-CN.md)。

## License

MIT — see [LICENSE](uniproxy/LICENSE).
