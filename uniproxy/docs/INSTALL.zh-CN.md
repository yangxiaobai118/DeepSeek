# uniproxy 安装与部署手册

> 适用版本：**0.3.3**　|　目标系统：Debian 11+ / Ubuntu 20.04+ / Rocky Linux 8+（glibc ≥ 2.28）
> 读者：负责在一台 Linux 服务器上完成部署的运维/开发人员
> 示例约定：域名 `example.com`，面板 `xui.example.com` / `sui.example.com`，订阅 `sub.example.com`，Reality SNI `www.bing.com`，服务器公网 IP 记为 `<server-ip>`

本手册按**实际操作顺序**编写。每一步都包含四部分：

- **目的**：这一步在做什么、为什么需要
- **操作**：可直接复制执行的命令或需要编辑的内容
- **预期结果**：正常情况下应该看到什么
- **不符合时**：常见原因与处理方式

> 所有命令默认以 `root` 执行。非 root 用户请在命令前加 `sudo`，或先执行 `sudo -i`。

---

## 0. 安装流程总览

| 步骤 | 做什么 | 预计耗时 | 是否可跳过 |
|------|--------|----------|-----------|
| 1 | 准备服务器、域名、端口、安装包 | 10 分钟 | 否 |
| 2 | 安装 uniproxy（二进制或 JS 包） | 3 分钟 | 否 |
| 3 | 安装 Xray、sing-box、nginx | 10 分钟 | 否 |
| 4 | 准备 TLS 证书 | 5–20 分钟 | 否（TLS/Reality 需要） |
| 5 | 初始化并编辑 `config.json` | 10 分钟 | 否 |
| 6 | `validate` + `doctor` 校验 | 2 分钟 | 否 |
| 7 | `generate` 生成三套配置 | 1 分钟 | 否 |
| 8 | `apply --yes` 下发并重启服务 | 3 分钟 | 否 |
| 9 | 启动订阅服务（可选） | 5 分钟 | 可跳过 |
| 10 | 验收：端口、TLS、面板、订阅、客户端 | 5 分钟 | 否 |

整体链路：

1. 准备服务器 → 安装 uniproxy → 安装三个内核 → 准备证书
2. `init` 生成配置 → `validate` / `doctor` 校验
3. `generate` 生成三套配置
4. `apply`（校验 + 备份 + 下发 + reload）→ `serve`（订阅）→ 验收

### 0.1 占位符约定（复制命令前必读）

代码块里下面这些值**不是字面量**，是给你替换的占位符。照着示例直接粘贴，多半会失败——先对照这张表：

| 代码里的写法 | 换成你自己的 | 为什么 | 照抄的后果 |
|---|---|---|---|
| `example.com`、`www.example.com`、`xui.example.com`、`sui.example.com`、`sub.example.com` | 你的真实域名和子域名 | 证书签发、nginx `server_name`、443 SNI 分流、订阅地址都按它匹配 | 证书签不出、面板打不开、订阅 404 |
| `www` / `xui` / `sui` / `sub`（例如 `for d in www xui sui sub`） | 你规划的子域名前缀，可增可减 | 循环会把前缀拼成 `$d.example.com` 去查解析 | 查到的是示例域名，你的域名没配好也可能“看到 IP” |
| `<server-ip>` | 服务器公网 IP | 客户端链接、`server.publicIp`、验收命令都用它 | 链接指向占位符，客户端连不上 |
| `203.0.113.10` | 真实公网 IP | 它是 RFC 5737 的示例保留地址，不是你的 IP | `validate` 直接报 `server.publicIp still a placeholder` |
| `<version>`、`0.3.3` | 实际版本号 | 下载 URL、资产名、安装路径都带版本 | 下载 404 |
| `<service>` | 真实服务名：`xray` / `sing-box` / `nginx` / `uniproxy-sub` | `journalctl -u` 按服务名过滤 | 查不到日志，误以为“没报错” |
| `<target>`、`<timestamp>` | 被备份的文件、备份时间 | `apply` 生成的 `.bak-<timestamp>` | 找不到备份，无法回滚 |
| `<uuid>`、`TOKEN=xxxx...` | `uniproxy users` 的 UUID、订阅 token | 客户端凭据与订阅鉴权 | 认证失败、订阅 403 |
| `10.0.0.0/8`、`corp.example.org`、`ads.example.net` | 你的内网段 / 域名 | 只是配置示例，表示“可以这样写” | 不影响启动，但分流规则会按示例生效 |

> **原则：命令可以照抄，但表里的值必须先换成自己的。** 尤其不要在未替换时执行涉及域名解析、证书签发、`apply` 的命令——会留下错误的中间状态，后面很难排查。
>
> 另外，代码块请**逐行执行**：整段粘贴可能因终端丢失换行被拼成一行而失败。

### 0.2 工作目录约定

本手册的命令默认从 **`/root`**（root 的家目录）开始，全程建议在**同一个 shell** 里按顺序执行。

- 凡是需要进入特定目录的地方，都会明确写出 `cd`，并说明**执行后停留在哪个目录**。
- `cd` 只影响当前 shell。如果你新开了终端、或 `sudo -i` 换了会话，请先回到手册指定的目录再继续。
- 大部分步骤使用绝对路径（`/etc/uniproxy/...`），与当前目录无关；只有下载 tar 包、复制证书这几步依赖当前目录，文里会单独标注。

---

## 1. 步骤 1：准备

### 目的

确认服务器满足最低要求、域名已解析、80/443 没有被其它程序占用，并选对安装包。

### 操作

**1.1 检查系统与架构**

```bash
uname -m
cat /etc/os-release | head -3
df -h / | tail -1
ss -lntp | grep -E ':(80|443)\b' || echo "80/443 free"
```

**1.2 解析域名**（在域名服务商处添加 A 记录）

| 域名 | 用途 |
|------|------|
| `www.example.com` | 网站 |
| `xui.example.com` | x-ui 面板（可选） |
| `sui.example.com` | s-ui 面板（可选） |
| `sub.example.com` | 订阅服务 |

检查解析：

```bash
for d in www xui sui sub; do echo -n "$d.example.com -> "; dig +short $d.example.com; done
```

> **替换点**：`example.com` 换成你的域名；`www xui sui sub` 是四个子域名前缀，按需增删。`dig` 只做查询、不改配置，但**必须先替换**——否则查到的是示例域名的解析，输出里有 IP 也说明不了你的域名已经生效。

**1.3 放行端口**

云厂商安全组放行 **TCP 80、443**（SSH 端口保留）；本机防火墙：

```bash
ufw allow 80/tcp && ufw allow 443/tcp   # Debian/Ubuntu
# firewall-cmd --permanent --add-service={http,https} && firewall-cmd --reload   # Rocky
```

**1.4 选择安装包**：优先使用单文件二进制（目标机不需要安装 Node.js）。

| `uname -m` 输出 | 下载资产 |
|------------------|----------|
| `x86_64` | `uniproxy-<version>-linux-x64` |
| `aarch64` | `uniproxy-<version>-linux-arm64` |
| `ppc64le` | `uniproxy-<version>-linux-ppc64le` |
| `s390x` | `uniproxy-<version>-linux-s390x` |
| Alpine（musl） | `uniproxy-<version>-linux-musl-x64` |

> 32 位 Linux/Windows 没有二进制：Node.js 官方已不再发布对应运行时。这类机器请用 JS 包（`uniproxy-<version>.tgz`）并自行安装 Node.js ≥ 18。

### 预期结果

- 架构为 `x86_64` 或 `aarch64`
- 发行版为 Debian 11+/Ubuntu 20.04+/Rocky 8+
- 四个域名都解析到 `<server-ip>`
- 80/443 空闲（输出类似 `80/443 free`）

### 不符合时

- 解析为空：检查 A 记录是否生效（`dig +short` 无输出），Cloudflare 用户注意代理模式先关闭（灰云）再申请证书。
- 80/443 被占用：`ss -lntp` 查看进程，先停止旧的 apache/nginx/caddy。

---

## 2. 步骤 2：安装 uniproxy

### 目的

把 `uniproxy` 命令装到 `/usr/local/bin`，后续所有配置都由它生成。

### 操作

**方式 A：单文件二进制（推荐）**

以下 4 步在**同一个 shell** 里依次执行。每步都是一行命令，整行复制也不会被拼坏。

第 1 步：进入目录并设定版本

```bash
cd /tmp && VERSION=0.3.3
```

> **替换点**：`VERSION` 改成你要安装的 Release 版本号（示例为当前版本）；资产名 `uniproxy-${VERSION}-linux-x64` 必须和 `uname -m` 对应（x86_64→`linux-x64`，aarch64→`linux-arm64`，见 1.4 的表）。版本号或资产名不对会直接 404。

第 2 步：下载二进制与校验文件

```bash
curl -fLO "https://github.com/yangxiaobai118/DeepSeek/releases/download/uniproxy-v${VERSION}/uniproxy-${VERSION}-linux-x64" && curl -fLO "https://github.com/yangxiaobai118/DeepSeek/releases/download/uniproxy-v${VERSION}/uniproxy-${VERSION}-linux-x64.sha256"
```

第 3 步：校验完整性（必须看到 `OK` 再继续）

```bash
sha256sum -c uniproxy-${VERSION}-linux-x64.sha256
```

第 4 步：安装并验证

```bash
install -m 0755 uniproxy-${VERSION}-linux-x64 /usr/local/bin/uniproxy && uniproxy --help
```

> **复制提示**：每一步只有一行命令，逐行复制最稳。如果你把多行代码块整段粘贴后命令连成了一行、报 `cd: too many arguments`，那是终端没保留换行；另外 `#` 注释在连成一行时会把后面的命令一起吞掉，所以本手册把说明都写在正文，不夹在命令之间。

**方式 B：JS 包（需要 Node.js ≥ 18）**

复用第 1 步设置的 `VERSION`，在同一个 shell 里执行：

```bash
curl -fLO "https://github.com/yangxiaobai118/DeepSeek/releases/download/uniproxy-v${VERSION}/uniproxy-${VERSION}.tgz"
```

```bash
npm install -g ./uniproxy-${VERSION}.tgz && uniproxy --help
```

不想全局安装，可以解压后直接运行：

```bash
tar -xzf uniproxy-${VERSION}.tgz && node uniproxy/src/index.js --help
```

**创建运行目录**

```bash
mkdir -p /etc/uniproxy/certs /var/lib/uniproxy /var/log/uniproxy
```

> **目录说明**：第 1 步的 `cd /tmp` 之后，本节所有下载/解压都在 `/tmp` 进行，**执行完本节仍停留在 `/tmp`**。下面的 `mkdir` 用的是绝对路径，与当前目录无关。

### 预期结果

- `sha256sum -c` 输出 `uniproxy-0.3.3-linux-x64: OK`
- `uniproxy --help` 输出：

```
uniproxy - unified Xray + sing-box + nginx control plane

Usage:
  uniproxy init      -c <config.json>            create a starter config with real secrets
  uniproxy validate  -c <config.json>            check schema + port conflicts
  uniproxy ports     -c <config.json>            print the resolved port map
  uniproxy generate  -c <config.json> [-o out]   write configs, links and subscriptions
  uniproxy links     -c <config.json>            print client share links
  uniproxy subscribe -c <config.json>            print per-client subscription URLs
  uniproxy users     -c <config.json>            list registry users, quotas and expiry
  uniproxy doctor    -c <config.json>            pre-flight diagnostics
  uniproxy apply     -c <config.json> [--yes]    validate, install and reload services
  uniproxy serve     -c <config.json> [-p 8787]  start the dashboard + subscription server
```

### 不符合时

- `404 Not Found`：版本号或资产名不对。打开 Releases 页面确认 `uniproxy-v0.3.3` 下的资产名，再替换 URL。
- `sha256sum: no properly formatted checksum lines found`：`.sha256` 文件没下载全，重新下载。
- `Permission denied`：加 `sudo`，或确认写入了 `/usr/local/bin`。
- 二进制报 `GLIBC_2.28 not found`：系统太旧，改用 JS 包并安装新版 Node。

---

## 3. 步骤 3：安装 Xray、sing-box、nginx

### 目的

uniproxy 只负责“生成配置并下发”，实际代理流量由 Xray / sing-box 处理，TLS 与 443 复用由 nginx 处理。

> **目录说明**：本节命令在步骤 2 结束的 `/tmp` 下执行。3.1（Xray）与 3.3（nginx）使用绝对路径，不依赖当前目录；3.2（sing-box）会显式 `cd /tmp`，执行后仍停留在 `/tmp`。

### 3.0 已经装过？先自检（可整节跳过）

uniproxy 不读取 `/tmp` 里的二进制，它按 **PATH** 调用 `xray` / `sing-box` / `nginx`，按 **systemd 单元名**重启/重载服务。所以已经装好的内核会被直接接管——但你要先确认它们**装没装、跑没跑**。

先跑这两条：

```bash
xray version; sing-box version; nginx -v
```

```bash
systemctl is-active xray sing-box nginx
```

**看输出，对号入座：**

| 你看到的情况 | 说明 | 你要做什么 |
|---|---|---|
| 三个版本号都打印，三条都是 `active` | 都装好且在跑 | **跳过 3.1–3.3，直接做步骤 4** |
| 某个命令 `command not found`，对应服务 `inactive` | 没装，或装在面板目录里没进 PATH | 见下面的 **3.0.1**：先确定谁管内核，再决定装不装 |
| 版本号能打印，但服务 `inactive` | 装了但没启动 | `systemctl enable --now xray`（sing-box 同理；nginx 用 `nginx`） |
| nginx 是 `active`，xray / sing-box 都是 `command not found` | 最常见：只装了 nginx | **只做 3.1 和 3.2，3.3 跳过** |
| 版本号能打印但报 `GLIBC_2.28 not found` 之类 | 系统太旧 | 改用 JS 包 + 新版 Node（见 1.4） |

> 例如输出里有 `nginx version: nginx/1.30.8`，而 `xray`、`sing-box` 都是 `command not found`、服务 `inactive`：说明 **nginx 已就绪，Xray 和 sing-box 还没装** → 做 3.1、3.2，3.3 不用做。

**「把二进制放进 `/usr/local/bin`」是什么意思？**

就是把**可执行文件**（比如 `xray`、`sing-box`）复制到 `/usr/local/bin` 目录——系统会自动在这个目录里找命令，放进去后直接敲 `xray` 就能用。

**这一步不需要你手动做**：

- 3.1 的官方安装脚本会自动装到 `/usr/local/bin` 并创建服务；
- 3.2 里的 `install -m 0755 ... /usr/local/bin/sing-box` 就是在「把二进制放进去」。

只有当你**从别处拿到一个现成的可执行文件**（别人给的、或已经解压到 `/opt` 的）时，才需要手动处理。最省事的是建一个「快捷方式」（软链）：

```bash
ln -s /opt/xray/xray /usr/local/bin/xray
```

（把 `/opt/xray/xray` 换成那个文件的实际路径；执行后 `xray` 就等于它。软链就是「快捷方式」。）

**服务名不是默认的**（比如叫 `my-xray`）时，`systemctl restart xray` 会失败，这时在 `config.json` 里覆盖：

```json
"apply": {
  "validate": { "xray": "/opt/xray/xray run -test -c {file}" },
  "reload":   { "xray": "systemctl restart my-xray" }
}
```

> **缺失会怎样**：`apply` 会先对生成的配置跑校验命令（`xray run -test` / `sing-box check` / `nginx -t`）；**命令不存在则校验失败，`apply` 直接中止，此时还没有写入任何文件**。所以自检不过就先别跑 `apply`；确实暂时缺某个校验器，可以用 `--skip-validate`（不推荐）。

### 3.0.1 已经装了 3x-ui / s-ui 怎么办？

3x-ui 和 s-ui 会**各自带一份内核**（3x-ui 带 Xray、s-ui 带 sing-box），并由面板自己启动。它们通常装在面板目录里（如 `/usr/local/x-ui/bin/`、`/usr/local/s-ui/bin/`），**不在 PATH**，所以 `xray version` / `sing-box version` 会报 `command not found`——这不代表没装。

**不能两边都管**：面板会写自己的配置并拉起内核，uniproxy 的 `apply` 也会写配置并 `systemctl restart xray` / `sing-box`，两者会互相覆盖、抢同一个端口。先选一种模式：

**模式 A：交给 uniproxy（推荐，想用它的配置生成 + 订阅 + doctor）**

1. 停掉面板，让出端口：

```bash
systemctl disable --now x-ui s-ui
```

2. 按 3.1 / 3.2 装官方内核——它们会自动创建 `xray` / `sing-box` 的 systemd 单元，`apply` 才能重启它们。
3. 继续步骤 4。之后入站、用户、订阅全部由 `config.json` 管理。

> 面板自带的内核可以留着不用。不要把它软链成 `xray` 就指望 `systemctl restart xray` 能工作——面板并没有创建名为 `xray` 的单元。

**模式 B：面板继续管内核，uniproxy 只做 nginx / 443**

1. 保留面板运行。
2. 在 `config.json` 里关掉两个内核：

```json
"xray":    { "enabled": false },
"singbox": { "enabled": false }
```

3. 这样 `apply` 只会写 nginx，不会生成或重启内核配置。
4. `nginx.mode: "stream"` 的 SNI 分流要按**面板里实际配置的入站**填 `sni` 和端口，否则 443 会转到空端口。

> 还要确认面板没占用 80/443：`ss -lntp | grep -E ':(80|443)\b'`。

### 3.1 Xray-core

本步与当前目录无关（安装脚本内部使用绝对路径），执行后仍停留在 `/tmp`。

第 1 步：安装 Xray（脚本同时创建 systemd 服务）

```bash
bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install
```

第 2 步：验证

```bash
xray version && systemctl is-active xray
```

### 3.2 sing-box

第 1 步：进入 `/tmp` 并设定版本

```bash
cd /tmp && SB=1.14.5
```

> **替换点**：`SB` 换成 sing-box 的最新稳定版；`linux-amd64` 要和架构对应（x86_64 用 `linux-amd64`，aarch64 用 `linux-arm64`）。本步显式 `cd /tmp`，执行后停留在 `/tmp`。

第 2 步：下载并解压

```bash
curl -fLO "https://github.com/SagerNet/sing-box/releases/download/v${SB}/sing-box-${SB}-linux-amd64.tar.gz" && tar -xzf "sing-box-${SB}-linux-amd64.tar.gz"
```

第 3 步：安装并验证

```bash
install -m 0755 "sing-box-${SB}-linux-amd64/sing-box" /usr/local/bin/sing-box && sing-box version
```

第 4 步：创建配置目录

```bash
mkdir -p /usr/local/etc/sing-box
```

创建服务单元 `/etc/systemd/system/sing-box.service`：

```ini
[Unit]
Description=sing-box service
After=network.target nss-lookup.target

[Service]
User=root
ExecStart=/usr/local/bin/sing-box run -c /usr/local/etc/sing-box/config.json
Restart=on-failure
RestartSec=5s
LimitNOFILE=infinity

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable sing-box
```

### 3.3 nginx（必须带 stream 模块）

本步使用绝对路径，与当前目录无关，执行后仍停留在 `/tmp`。Rocky / AlmaLinux 请把第一条命令换成 `dnf install -y nginx`。

```bash
apt update && apt install -y nginx
```

```bash
nginx -V 2>&1 | grep -o -- --with-stream
```

```bash
cp /etc/nginx/nginx.conf "/etc/nginx/nginx.conf.dist-$(date +%F)"
```

> 后续 `apply` 会用生成的配置**整体替换** `/etc/nginx/nginx.conf`（默认路径，可在 `config.json` 的 `apply.nginxConfig` 中改）。上面这一步备份是为了出问题时能回退到发行版原配置。

### 预期结果

- `xray version` 输出 `Xray 25.x ...`
- `sing-box version` 输出 `sing-box version 1.14.x`
- `nginx -V` 中出现 `--with-stream`
- 三个命令都能执行，说明二进制已在 PATH 中

### 不符合时

- `xray: command not found`：安装脚本失败，重跑并看输出；或手动下载 Xray release 包。
- `nginx -V` 没有 `--with-stream`：该发行版 nginx 未编译 stream 模块，换官方 nginx 源安装，或使用 `http` 模式（`nginx.mode: "http"`，不推荐）。
- sing-box 服务此时可能启动失败（配置还没生成），这是正常的，步骤 8 之后会恢复。

---

## 4. 步骤 4：准备证书

### 目的

nginx、Xray TLS 入站、sing-box TLS 入站共用同一份证书：

```
/etc/uniproxy/certs/fullchain.pem   # leaf + intermediates
/etc/uniproxy/certs/privkey.pem     # private key
```

### 方案 A：已有证书（推荐）

把 `fullchain.pem` 和 `privkey.pem` 上传到服务器上的任意目录（示例用 `/root/certs`），然后**进入该目录**再执行——下面的 `install` 读的是当前目录下的这两个文件。执行后你停留在该目录；后续步骤都用绝对路径，不受影响。

第 1 步：进入证书所在目录（按你的实际路径改）

```bash
cd /root/certs
```

第 2 步：复制到 uniproxy 证书目录并修正权限

```bash
install -m 0644 fullchain.pem /etc/uniproxy/certs/fullchain.pem && install -m 0600 privkey.pem /etc/uniproxy/certs/privkey.pem && chown root:root /etc/uniproxy/certs/*
```

第 3 步：校验证书

```bash
openssl x509 -in /etc/uniproxy/certs/fullchain.pem -noout -subject -dates
```

证书必须覆盖所有对外域名（`www/xui/sui/sub` 以及 TLS 入站的 SNI）。通配符证书 `*.example.com` 可以一次覆盖。

### 方案 B：Let's Encrypt（DNS-01，可申请通配符）

```bash
apt install -y certbot
certbot certonly --manual --preferred-challenges dns \
  -d example.com -d '*.example.com'
# add the TXT record as prompted

install -m 0644 /etc/letsencrypt/live/example.com/fullchain.pem /etc/uniproxy/certs/fullchain.pem
install -m 0600 /etc/letsencrypt/live/example.com/privkey.pem  /etc/uniproxy/certs/privkey.pem
```

> **替换点**：两处 `example.com` 换成你的域名；`-d '*.example.com'` 申请通配符证书，覆盖 `www` / `xui` / `sui` / `sub` 等所有子域名。执行时 certbot 会要求你在 DNS 添加一条 TXT 记录——**真的加上并等它生效**再回车，否则签发失败；后面 `install` 命令里的路径也要按实际域名改。

> 自动续期不在本手册范围内。生产环境建议用 DNS 插件 + `--deploy-hook` 复制证书并 `systemctl reload nginx`。

### 方案 C：Let's Encrypt（HTTP-01，80 端口空闲时）

```bash
systemctl stop nginx
certbot certonly --standalone -d www.example.com -d xui.example.com -d sui.example.com -d sub.example.com
systemctl start nginx
```

> **替换点**：四个 `-d` 都换成你的真实域名（网站 + 两个面板 + 订阅）。HTTP-01 要求 80 端口对公网可达，所以先停 nginx、签完再启动；`example.com` 不要保留。

### 预期结果

```
subject=CN = example.com
notBefore=... notAfter=... (in the future)
```

> 说明：这是**示例输出**。`subject=CN` 会显示你自己的域名，`notAfter` 是证书实际到期时间。

### 不符合时

- `unable to load certificate`：文件不是 PEM 或下载不完整，重新导出。
- 私钥权限 600 且属主 root：nginx 以 root 启动可读；如改用非 root 运行需调整属主。
- Cloudflare 小黄云开启时 HTTP-01 校验会失败：改用 DNS-01 或临时关闭代理。

---

## 5. 步骤 5：初始化并编辑配置

### 目的

生成一份带随机 Reality 密钥、UUID、`server.secret` 的配置，然后填入你的真实信息。

### 操作

```bash
uniproxy init -c /etc/uniproxy/config.json
```

预期输出：

```
created /etc/uniproxy/config.json with freshly generated Reality keypair + UUIDs
next: edit server.publicIp / domains / cert paths, then run "uniproxy validate"
```

用编辑器打开 `/etc/uniproxy/config.json`，按下面清单修改：

| 字段 | 改成什么 | 说明 |
|------|----------|------|
| `server.publicIp` | `<server-ip>` | 客户端链接里的地址 |
| `server.email` | 你的邮箱 | 证书/联络信息 |
| `server.secret` | **保持 init 生成的值** | 用于派生用户凭据；泄露等于凭据可被推算 |
| `server.cert.certFile` | `/etc/uniproxy/certs/fullchain.pem` | 与步骤 4 一致 |
| `server.cert.keyFile` | `/etc/uniproxy/certs/privkey.pem` | 同上 |
| `panels.xui.enabled` | 不用 x-ui 就改 `false` | 面板没装却设为 true，nginx 会回 502 |
| `panels.xui.domain` | `xui.example.com` | 面板域名 |
| `panels.sui.enabled` / `domain` | 同上 | s-ui 面板 |
| `panels.sui.sub` | 用 s-ui 自带订阅才保留 | 否则 `"sub": { "enabled": false }` |
| `nginx.mode` | `stream`（推荐） | 443 由 nginx 按 SNI 分流 |
| `nginx.sites[0].serverName` | `www.example.com` | 网站域名 |
| `nginx.sites[0].root` | `/var/www/html` | 网站目录（需存在 index.html） |
| `nginx.extraSites` | 见步骤 9 | 订阅域名反代到 127.0.0.1:8787 |
| `xray.inbounds[0].sni` | `www.bing.com` 等真实站点 | 必须与 `reality.serverNames` 一致 |
| `xray.inbounds[0].port` | `10443`（保持 127.0.0.1） | 由 nginx 443 分流进入 |
| `xray.inbounds[0].clients` | 你的用户 UUID/name | 或改用顶层 `users` |
| `singbox.inbounds[0].sni` | `sb.example.com`（需有证书） | 或改成证书覆盖的域名 |
| `subscription.publicBase` | `https://sub.example.com` | 订阅 URL 前缀 |
| `subscription.routing` | 按需 | 直连/屏蔽/绕局域网规则 |
| `apply.xrayConfig` | `/usr/local/etc/xray/config.json` | 默认即可 |
| `apply.singboxConfig` | `/usr/local/etc/sing-box/config.json` | 默认即可 |
| `apply.nginxConfig` | `/etc/nginx/nginx.conf` | **必须与 nginx 实际加载的配置文件一致** |
| `apply.reload` | 默认 `systemctl restart/reload` | 自定义安装路径时才需要改 |

**用户示例**（顶层 `users`，一个用户跨两个内核）：

```json
"users": [
  {
    "name": "alice",
    "inbounds": ["xray-vless-reality", "sb-vless-ws-tls"],
    "expireAt": "2027-01-01T00:00:00Z",
    "dataLimitBytes": 107374182400,
    "usage": { "upload": 0, "download": 0 }
  }
]
```

> **替换点**：`alice` 换成你的用户名；`inbounds` 填你实际要下发的入站 `tag`（见 `config.json` 里的 `xray.inbounds` / `singbox.inbounds`）；`expireAt`、`dataLimitBytes` 按需改或删掉（删掉即不限）。这一段是**粘进** `config.json` 的 `users` 数组，不是命令。

> `inbounds` 里列出的入站会自动获得 alice 的凭据（VLESS/VMess 为 UUID，Trojan 为密码），由 `server.secret` 确定性派生，重复生成不会变。

### 预期结果

- 文件存在且为合法 JSON
- `server.secret` 为一长串随机字符
- 所有 `example.com` 都已替换成你的真实域名（或明确禁用对应功能）

### 不符合时

- `refusing to overwrite existing`：配置文件已存在。备份后删除再 init，或直接编辑旧文件。
- JSON 语法错误：用 `python3 -m json.tool /etc/uniproxy/config.json > /dev/null` 定位。

---

## 6. 步骤 6：校验配置与预检

### 目的

在改动系统之前，先用项目自带的校验和 `doctor` 把配置错误、端口冲突、证书问题找出来。

### 操作

```bash
uniproxy validate -c /etc/uniproxy/config.json
uniproxy doctor   -c /etc/uniproxy/config.json
```

### 预期结果

`validate`：

```
PORT   COMPONENT                LISTEN
------ ------------------------ ----------------
80     nginx:http               0.0.0.0
443    nginx:https              0.0.0.0
8443   nginx:internal-tls       0.0.0.0
54321  panel:x-ui               127.0.0.1
2095   panel:s-ui               127.0.0.1
2096   panel:s-ui-sub           127.0.0.1
10443  xray:xray-vless-reality  127.0.0.1
2052   singbox:sb-vless-ws-tls  127.0.0.1


OK - 0 errors, 0 warning(s)
```

`doctor`（每行 OK/WARN/FAIL，最后统计）：

```
OK    config loaded      /etc/uniproxy/config.json
OK    node runtime       ...
OK    ports              8 listeners, no conflicts
OK    server.publicIp    203.0.113.10
OK    reality key        xray:xray-vless-reality public key ...
OK    certificate        valid for 89 day(s), subject ...
OK    subscriptions      2 client profile(s) under /sub/<token>
OK    users              1 registry user(s), 1 active
OK    binary xray        Xray 25.x ...
OK    binary sing-box    sing-box version 1.14.x
OK    binary nginx       nginx version: nginx/1.24.x

0 failure(s), 0 warning(s)
```

> 说明：这是**示例输出**。`203.0.113.10` 是示例 IP，实际会显示你填的 `server.publicIp`；如果看到 `FAIL ... still a placeholder`，说明还没换成真实 IP。

> `doctor` 有 FAIL 时退出码为 1；只有 WARN 时退出码 0，可以继续。

### 不符合时

| 输出 | 含义 | 处理 |
|------|------|------|
| `ERROR port 443 is claimed by ...` | 两个组件抢同一端口 | 改 `config.json` 中的端口 |
| `FAIL server.publicIp still a placeholder` | 仍是 203.0.113.x | 填真实公网 IP |
| `FAIL reality key` | privateKey 不是 32 字节 base64url | 重新 `init` 或生成密钥对 |
| `WARN certificate ... not readable` | 本机没有证书 | 步骤 4 未完成 |
| `WARN binary xray not runnable` | 内核未安装 | 步骤 3 未完成 |
| `ERROR duplicate inbound tag` | tag 重名 | 改名 |

---

## 7. 步骤 7：生成配置（不落系统）

### 目的

把 `config.json` 展开成 Xray / sing-box / nginx 三套原生配置、客户端链接和订阅文件，先看产物，不动系统。

### 操作

```bash
uniproxy generate -c /etc/uniproxy/config.json -o /var/lib/uniproxy/out
```

### 预期结果

```
generated:
  /var/lib/uniproxy/out/xray/config.json
  /var/lib/uniproxy/out/singbox/config.json
  /var/lib/uniproxy/out/nginx/nginx.conf
  /var/lib/uniproxy/out/links.txt
  /var/lib/uniproxy/out/sub/alice-<token>.txt
  /var/lib/uniproxy/out/sub/alice-<token>.json
  /var/lib/uniproxy/out/sub/alice-<token>.clash.yaml
  /var/lib/uniproxy/out/SUMMARY.md
```

> 说明：这是**示例输出**。`alice` 是用户名、`<token>` 是实际生成的订阅 token，都会随你的配置变化。

检查产物：

```bash
ls -R /var/lib/uniproxy/out
sed -n '1,40p' /var/lib/uniproxy/out/SUMMARY.md
head -2 /var/lib/uniproxy/out/links.txt
```

`SUMMARY.md` 应包含端口表、文件清单、订阅地址、客户端链接。

### 不符合时

- `fix errors before generating`：配置仍有错误，回到步骤 6。
- 文件没生成：检查 `-o` 目录写权限（`/var/lib/uniproxy`）。

> `generate` 只写输出目录，可以反复执行，不会影响线上服务。

---

## 8. 步骤 8：下发并重启服务

### 目的

把生成的三套配置安装到系统路径，校验后 reload 服务。`apply` 会先校验、再备份、后写入，失败自动回滚。

### 操作

**先看计划（dry-run，不写任何文件）**

```bash
uniproxy apply -c /etc/uniproxy/config.json
```

预期：

```
apply plan:
  xray    /usr/local/etc/xray/config.json  [changed]
           validate: xray run -test -c {file}
           reload:   systemctl restart xray
  singbox /usr/local/etc/sing-box/config.json  [changed]
           validate: sing-box check -c {file}
           reload:   systemctl restart sing-box
  nginx   /etc/nginx/nginx.conf  [changed]
           validate: nginx -t -c {file}
           reload:   systemctl reload nginx

dry run: re-run with --yes to write these files and reload the services
```

**确认无误后真正执行**

```bash
uniproxy apply -c /etc/uniproxy/config.json --yes
```

### 预期结果

```
OK  validated xray config
OK  validated singbox config
OK  validated nginx config
OK  installed /usr/local/etc/xray/config.json
OK  installed /usr/local/etc/sing-box/config.json
OK  installed /etc/nginx/nginx.conf
OK  reloaded xray: systemctl restart xray
OK  reloaded singbox: systemctl restart sing-box
OK  reloaded nginx: systemctl reload nginx
```

随后检查服务：

```bash
systemctl is-active xray sing-box nginx
ss -lntp | grep -E ':(80|443|8443)\b'
```

预期：三个服务都输出 `active`；80/443/8443 由 nginx 监听；10443/2052 由内核监听在 `127.0.0.1`。

### 不符合时

- 任何一行 `FAIL`：命令会停在失败处，**不会继续写入后续文件**；已写入的文件会自动恢复到备份（提示 `restored previous configs`）。
- `xray run -test` 失败：按输出的行号修 `config.json`（常见是 Reality 参数或 flow）。
- `nginx -t` 失败：多为证书路径不存在、证书/私钥不匹配、端口被占用。
- `reload failed`：看 `journalctl -u <service> -n 50`；修复后重跑 `apply`。
- 想跳过某个校验：`--skip-validate`（不推荐）；想只写不重启：`--skip-reload`。
- 手动回退：`apply` 会在目标旁生成 `<target>.bak-<timestamp>`，复制回去并 reload 即可。

---

## 9. 步骤 9：启动订阅服务（可选）

### 目的

让客户端通过一个 URL 拿到全部节点（base64 链接 / sing-box JSON / Clash YAML）。

### 方式 A：uniproxy 自带订阅（推荐，零额外组件）

创建 `/etc/systemd/system/uniproxy-sub.service`：

```ini
[Unit]
Description=uniproxy dashboard and subscriptions
After=network.target

[Service]
User=root
ExecStart=/usr/local/bin/uniproxy serve -c /etc/uniproxy/config.json -p 8787
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now uniproxy-sub
systemctl status uniproxy-sub --no-pager
curl -fsS http://127.0.0.1:8787/api/state | head -c 300; echo
```

然后在 `config.json` 中加入公网入口：

```json
"nginx": {
  "mode": "stream",
  "extraSites": [
    { "serverName": "sub.example.com", "upstream": "127.0.0.1:8787" }
  ]
}
```

> **替换点**：`sub.example.com` 换成你的订阅域名；`127.0.0.1:8787` 是 `serve` 的默认监听地址，如果你改过 `serve` 端口要同步改。这一段是**合并进** `config.json` 的 `nginx` 段，不是命令。

重新下发一次：

```bash
uniproxy apply -c /etc/uniproxy/config.json --yes
```

### 方式 B：使用 s-ui 自带订阅

如果已安装 s-ui 并启用 `panels.sui.sub`（端口 2096），nginx 已经添加 `sub.example.com` 的 vhost，直接使用 s-ui 面板里的订阅链接即可。**两种方式只选一种**，避免同一域名被覆盖。

### 预期结果

- `systemctl status uniproxy-sub` 为 `active (running)`
- `curl http://127.0.0.1:8787/api/state` 返回 JSON（包含 ports/links/subscriptions）
- `https://sub.example.com/sub/<token>` 可访问（步骤 10 验证）

### 不符合时

- 8787 被占用：改 `-p` 端口，并同步改 `extraSites.upstream`。
- `extraSites` 加了却不生效：没重新 `apply`，nginx 还是旧配置。
- 访问返回 502：`uniproxy-sub` 没启动，`journalctl -u uniproxy-sub -n 30` 查看原因。

---

## 10. 步骤 10：验收

### 1）端口与服务

```bash
systemctl is-active xray sing-box nginx uniproxy-sub
ss -lntp | grep -E ':(80|443|8443|10443|2052|8787)\b'
```

预期：全部 `active`；80/443/8443 是 nginx，10443/2052/8787 绑定 `127.0.0.1`。

### 2）网站与 TLS

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://www.example.com
curl -sSI https://www.example.com | head -5
openssl s_client -connect www.example.com:443 -servername www.example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -dates
```

> **替换点**：三处 `www.example.com` 都换成你的网站域名。`%{http_code}` 期望 `200` 或 `301/302`；`openssl s_client` 的 `-servername` 必须和域名一致，否则 SNI 分流会走到别的后端。

预期：HTTP 200/301；证书 subject 为你的域名且未过期。

### 3）面板

```bash
curl -sS -o /dev/null -w 'xui=%{http_code}\n' https://xui.example.com
curl -sS -o /dev/null -w 'sui=%{http_code}\n' https://sui.example.com
```

> **替换点**：`xui.example.com` / `sui.example.com` 换成你的面板域名。`200/302` 正常；`502` 说明面板进程没起或反代上游端口不对。

预期：200/302。未安装面板请确认 `config.json` 中已 `enabled: false`，否则会 502。

### 4）客户端链接

```bash
uniproxy links -c /etc/uniproxy/config.json | head -3
```

预期：

```
vless://<uuid>@<server-ip>:443?encryption=none&type=tcp&security=reality&sni=www.bing.com&fp=chrome&pbk=...&sid=...&flow=xtls-rprx-vision#xray-vless-reality-alice
```

> 说明：这是**示例输出**。`<uuid>`、`<server-ip>`、`pbk=...` 会在你实际运行时变成真实值，不要照抄。

### 5）订阅

```bash
uniproxy subscribe -c /etc/uniproxy/config.json
```

预期每行包含 `links/json/clash` 三个 URL。取其中一个 token 验证：

```bash
TOKEN=xxxxxxxxxxxxxxxxxxxxxxxx
curl -fsS "https://sub.example.com/sub/${TOKEN}" | base64 -d | head -2
curl -sSI "https://sub.example.com/sub/${TOKEN}" | grep -iE 'subscription-userinfo|profile-title|cache-control'
```

> **替换点**：`TOKEN` 换成上一步 `uniproxy subscribe` 输出里的真实 token（`links` / `json` / `clash` 三个 URL 用的是同一个 token）；`sub.example.com` 换成你的订阅域名。订阅接口按 token 鉴权，留着占位符只会得到 404 / 403。

预期：解出 `vless://...`；响应头包含 `profile-title`、`cache-control: no-store`，用户有到期/配额时还包含 `subscription-userinfo`。

### 6）客户端导入

- **v2rayN / NekoBox / Shadowrocket**：粘贴 `/sub/<token>`（base64 链接）
- **sing-box**：导入 `/sub/<token>/json`
- **Clash / Mihomo**：导入 `/sub/<token>/clash`

导入后测延迟、打开网页确认代理生效。

### 不符合时

| 现象 | 排查 |
|------|------|
| 443 连不上 | nginx 是否 active；云安全组是否放行 |
| TLS 证书错误 | 证书是否覆盖该域名；`openssl` 检查 |
| 链接能导入但连不上 | Reality 私钥/公钥、shortId、SNI 是否匹配；查看 xray 日志 |
| 订阅 404 | token 错 / uniproxy-sub 未启动 |
| 订阅 403 | 用户过期、超配额或被禁用（`uniproxy users` 查看状态） |
| 面板 502 | 面板进程未运行 / 端口不符 / 域名未进 stream map |

---

## 11. 日常运维

### 11.1 新增用户

编辑 `/etc/uniproxy/config.json` 的 `users` 数组，追加：

```json
{ "name": "bob", "inbounds": ["xray-vless-reality", "sb-vless-ws-tls"], "expireAt": "2027-06-01T00:00:00Z" }
```

> **替换点**：`bob` 换成新用户名；`inbounds` 填要下发的入站 `tag`；`expireAt` 按需改。这是**追加**到 `config.json` 的 `users` 数组里的对象。

```bash
uniproxy users     -c /etc/uniproxy/config.json   # bob should be active
uniproxy validate  -c /etc/uniproxy/config.json
uniproxy generate  -c /etc/uniproxy/config.json -o /var/lib/uniproxy/out
uniproxy apply     -c /etc/uniproxy/config.json --yes
```

> **替换点**：`bob`（在注释里）换成你上一步新增的用户名；后面 `validate` / `generate` / `apply` 用的是同一个 `config.json`，路径不同要一起改。

预期：`users` 表格出现 bob；apply 后 bob 的订阅 URL 生效。

### 11.2 修改协议/端口/新增入站

1. 编辑 `config.json`
2. `uniproxy validate`（确认端口不冲突）
3. `uniproxy doctor`（确认证书/密钥/内核）
4. `uniproxy generate` → `uniproxy apply --yes`
5. 按步骤 10 复验

### 11.3 升级 uniproxy

本节的下载、校验、安装都在 `/tmp` 进行（第 2 条命令显式 `cd /tmp`），执行后停留在 `/tmp`；后面的 `doctor` / `apply` 用绝对路径。

第 1 步：停订阅服务

```bash
systemctl stop uniproxy-sub
```

第 2 步：进入 `/tmp` 并设定新版本号

```bash
cd /tmp && VERSION=<new-version>
```

> **替换点**：`<new-version>` 换成目标版本号；下面的资产名要和架构对应（x86_64 用 `linux-x64`，aarch64 用 `linux-arm64`）。先停 `uniproxy-sub`、升级后跑 `doctor` + `apply`，是为了避免新二进制配旧配置。

第 3 步：下载并校验

```bash
curl -fLO "https://github.com/yangxiaobai118/DeepSeek/releases/download/uniproxy-v${VERSION}/uniproxy-${VERSION}-linux-x64" && curl -fLO "https://github.com/yangxiaobai118/DeepSeek/releases/download/uniproxy-v${VERSION}/uniproxy-${VERSION}-linux-x64.sha256" && sha256sum -c uniproxy-${VERSION}-linux-x64.sha256
```

第 4 步：安装并验证

```bash
install -m 0755 uniproxy-${VERSION}-linux-x64 /usr/local/bin/uniproxy && uniproxy --help
```

第 5 步：预检并下发，然后恢复订阅服务

```bash
uniproxy doctor -c /etc/uniproxy/config.json && uniproxy apply -c /etc/uniproxy/config.json --yes
```

```bash
systemctl start uniproxy-sub
```

预期：服务恢复；apply 自动保留旧配置备份。

### 11.4 备份清单

| 路径 | 内容 |
|------|------|
| `/etc/uniproxy/` | 主配置 + 证书 |
| `/etc/nginx/nginx.conf` | 生成的 nginx 配置 |
| `/usr/local/etc/xray/config.json` | Xray 配置 |
| `/usr/local/etc/sing-box/config.json` | sing-box 配置 |
| `/etc/systemd/system/*.service` | 服务单元 |

```bash
tar -czf /root/uniproxy-backup-$(date +%F).tar.gz \
  /etc/uniproxy /etc/nginx/nginx.conf /usr/local/etc/xray /usr/local/etc/sing-box
```

### 11.5 日志

```bash
journalctl -u xray -n 50 --no-pager
journalctl -u sing-box -n 50 --no-pager
journalctl -u nginx -n 50 --no-pager
journalctl -u uniproxy-sub -n 50 --no-pager
tail -n 50 /var/log/nginx/error.log
```

---

## 12. 故障排查速查表

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| `uniproxy validate` 端口冲突 | 两个组件同端口 | 修改 `config.json` 端口 |
| apply 校验失败 | 生成的配置不合法 | 输出里有失败命令，手动执行看详细报错 |
| apply 后 443 断开 | nginx 配置被替换但 reload 失败 | `nginx -t`，`journalctl -u nginx`；用 `.bak-*` 回滚 |
| 网站 502 / 面板 502 | 面板没启动或端口不符 | `ss -lntp` 查看实际端口，改配置 |
| Reality 握手失败 | 私钥/公钥不匹配、shortId 错、SNI 不在 serverNames | `doctor` 检查；重新生成密钥对 |
| 订阅 403 | 用户 expired/quota/disabled | `uniproxy users` 查看并调整 |
| 订阅 404 | token 不对、服务未启动 | 重新 `subscribe` 取 token；查 `uniproxy-sub` |
| 客户端能连不能用 | 服务器出站被封/DNS 问题 | 在服务器上 `curl -I https://www.google.com` 测试 |
| nginx 反代被 SELinux 拦 | RHEL 系默认策略 | `setsebool -P httpd_can_network_connect 1` |
| 证书过期 | 未续期 | 重新签发并 `systemctl reload nginx` |
| `doctor` 说证书不可读 | 权限/路径 | `ls -l /etc/uniproxy/certs`，root 可读 |

---

## 13. 卸载

> 先备份证书与配置；以下操作会删除数据。

```bash
systemctl disable --now xray sing-box nginx uniproxy-sub

rm -f /etc/systemd/system/uniproxy-sub.service
systemctl daemon-reload

rm -f /usr/local/bin/uniproxy /usr/local/bin/sing-box
bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ remove

rm -rf /etc/uniproxy /usr/local/etc/xray /usr/local/etc/sing-box /var/lib/uniproxy
```

如需卸载 nginx：`apt purge -y nginx nginx-common`（会删除 `/etc/nginx`）。

---

## 附录 A：systemd 单元模板

**`/etc/systemd/system/sing-box.service`**

```ini
[Unit]
Description=sing-box service
After=network.target nss-lookup.target

[Service]
User=root
ExecStart=/usr/local/bin/sing-box run -c /usr/local/etc/sing-box/config.json
Restart=on-failure
RestartSec=5s
LimitNOFILE=infinity

[Install]
WantedBy=multi-user.target
```

**`/etc/systemd/system/uniproxy-sub.service`**

```ini
[Unit]
Description=uniproxy dashboard and subscriptions
After=network.target

[Service]
User=root
ExecStart=/usr/local/bin/uniproxy serve -c /etc/uniproxy/config.json -p 8787
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

## 附录 B：命令速查

| 命令 | 作用 | 常用参数 |
|------|------|----------|
| `uniproxy init` | 生成带随机密钥的初始配置 | `-c` |
| `uniproxy validate` | 校验结构、协议/传输、端口冲突 | `-c` |
| `uniproxy doctor` | 预检证书、密钥、内核、用户 | `-c`、`--json`、`--no-probe` |
| `uniproxy generate` | 生成三套配置 + 链接 + 订阅 | `-c`、`-o` |
| `uniproxy apply` | 校验 + 备份 + 下发 + reload | `-c`、`--yes`、`--skip-validate`、`--skip-reload` |
| `uniproxy links` | 打印客户端链接 | `-c`、`--client`、`--json` |
| `uniproxy subscribe` | 打印订阅 URL | `-c`、`--json` |
| `uniproxy users` | 用户列表/状态/配额 | `-c`、`--json` |
| `uniproxy ports` | 端口地图 | `-c` |
| `uniproxy serve` | 仪表盘 + 订阅 HTTP 服务 | `-c`、`-p` |

## 附录 C：端口说明

| 端口 | 组件 | 监听 | 说明 |
|------|------|------|------|
| 80 | nginx | 0.0.0.0 | HTTP→HTTPS 跳转 / ACME |
| 443 | nginx（stream） | 0.0.0.0 | 按 SNI 分流到各后端 |
| 8443 | nginx（内部 TLS） | 127.0.0.1 | 网站/面板 vhost |
| 10443 | Xray Reality | 127.0.0.1 | 经 443 SNI 进入 |
| 2052 | sing-box WS+TLS | 127.0.0.1 | 经 443 SNI 进入 |
| 2095 | s-ui 面板 | 127.0.0.1 | nginx 反代 |
| 2096 | s-ui 订阅 | 127.0.0.1 | nginx 反代 |
| 54321 | x-ui 面板 | 127.0.0.1 | nginx 反代 |
| 8787 | uniproxy serve | 127.0.0.1 | 仪表盘 + 订阅 |

---

> 安全提醒：本手册的示例只用于个人学习与合法的自建基础设施管理。部署前请确认当地法律法规，并妥善保管 `server.secret`、Reality 私钥、证书私钥与订阅 token。
