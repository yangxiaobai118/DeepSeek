# uniproxy 安装与部署手册

> 适用版本：**0.3.2**　|　目标系统：Debian 11+ / Ubuntu 20.04+ / Rocky Linux 8+（glibc ≥ 2.28）
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
| `<version>`、`0.3.2` | 实际版本号 | 下载 URL、资产名、安装路径都带版本 | 下载 404 |
| `<service>` | 真实服务名：`xray` / `sing-box` / `nginx` / `uniproxy-sub` | `journalctl -u` 按服务名过滤 | 查不到日志，误以为“没报错” |
| `<target>`、`<timestamp>` | 被备份的文件、备份时间 | `apply` 生成的 `.bak-<timestamp>` | 找不到备份，无法回滚 |
| `<uuid>`、`TOKEN=xxxx...` | `uniproxy users` 的 UUID、订阅 token | 客户端凭据与订阅鉴权 | 认证失败、订阅 403 |
| `10.0.0.0/8`、`corp.example.org`、`ads.example.net` | 你的内网段 / 域名 | 只是配置示例，表示“可以这样写” | 不影响启动，但分流规则会按示例生效 |

> **原则：命令可以照抄，但表里的值必须先换成自己的。** 尤其不要在未替换时执行涉及域名解析、证书签发、`apply` 的命令——会留下错误的中间状态，后面很难排查。

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

```bash
cd /tmp
VERSION=0.3.2
curl -fLO "https://github.com/yangxiaobai118/DeepSeek/releases/download/uniproxy-v${VERSION}/uniproxy-${VERSION}-linux-x64"
curl -fLO "https://github.com/yangxiaobai118/DeepSeek/releases/download/uniproxy-v${VERSION}/uniproxy-${VERSION}-linux-x64.sha256"

# must print OK before continuing
sha256sum -c uniproxy-${VERSION}-linux-x64.sha256

install -m 0755 uniproxy-${VERSION}-linux-x64 /usr/local/bin/uniproxy
uniproxy --help
```

**方式 B：JS 包（需要 Node.js ≥ 18）**

```bash
curl -fLO "https://github.com/yangxiaobai118/DeepSeek/releases/download/uniproxy-v${VERSION}/uniproxy-${VERSION}.tgz"
npm install -g ./uniproxy-${VERSION}.tgz
uniproxy --help
# or without installing: tar -xzf uniproxy-${VERSION}.tgz && node uniproxy/src/index.js --help
```

**创建运行目录**

```bash
mkdir -p /etc/uniproxy/certs /var/lib/uniproxy /var/log/uniproxy
```

### 预期结果

- `sha256sum -c` 输出 `uniproxy-0.3.2-linux-x64: OK`
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

- `404 Not Found`：版本号或资产名不对。打开 Releases 页面确认 `uniproxy-v0.3.2` 下的资产名，再替换 URL。
- `sha256sum: no properly formatted checksum lines found`：`.sha256` 文件没下载全，重新下载。
- `Permission denied`：加 `sudo`，或确认写入了 `/usr/local/bin`。
- 二进制报 `GLIBC_2.28 not found`：系统太旧，改用 JS 包并安装新版 Node。

---

## 3. 步骤 3：安装 Xray、sing-box、nginx

### 目的

uniproxy 只负责“生成配置并下发”，实际代理流量由 Xray / sing-box 处理，TLS 与 443 复用由 nginx 处理。

### 3.1 Xray-core

```bash
bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install
xray version
systemctl is-active xray
```

### 3.2 sing-box

```bash
cd /tmp
SB=1.12.0   # use the latest stable release
curl -fLO "https://github.com/SagerNet/sing-box/releases/download/v${SB}/sing-box-${SB}-linux-amd64.tar.gz"
tar -xzf "sing-box-${SB}-linux-amd64.tar.gz"
install -m 0755 "sing-box-${SB}-linux-amd64/sing-box" /usr/local/bin/sing-box
sing-box version
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

```bash
apt update && apt install -y nginx        # Rocky: dnf install -y nginx
nginx -V 2>&1 | grep -o -- --with-stream
cp /etc/nginx/nginx.conf "/etc/nginx/nginx.conf.dist-$(date +%F)"
```

> 后续 `apply` 会用生成的配置**整体替换** `/etc/nginx/nginx.conf`（默认路径，可在 `config.json` 的 `apply.nginxConfig` 中改）。上面这一步备份是为了出问题时能回退到发行版原配置。

### 预期结果

- `xray version` 输出 `Xray 25.x ...`
- `sing-box version` 输出 `sing-box version 1.12.x`
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

```bash
install -m 0644 fullchain.pem /etc/uniproxy/certs/fullchain.pem
install -m 0600 privkey.pem  /etc/uniproxy/certs/privkey.pem
chown root:root /etc/uniproxy/certs/*
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

> 自动续期不在本手册范围内。生产环境建议用 DNS 插件 + `--deploy-hook` 复制证书并 `systemctl reload nginx`。

### 方案 C：Let's Encrypt（HTTP-01，80 端口空闲时）

```bash
systemctl stop nginx
certbot certonly --standalone -d www.example.com -d xui.example.com -d sui.example.com -d sub.example.com
systemctl start nginx
```

### 预期结果

```
subject=CN = example.com
notBefore=... notAfter=... (in the future)
```

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
OK    binary sing-box    sing-box version 1.12.x
OK    binary nginx       nginx version: nginx/1.24.x

0 failure(s), 0 warning(s)
```

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

预期：HTTP 200/301；证书 subject 为你的域名且未过期。

### 3）面板

```bash
curl -sS -o /dev/null -w 'xui=%{http_code}\n' https://xui.example.com
curl -sS -o /dev/null -w 'sui=%{http_code}\n' https://sui.example.com
```

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

```bash
uniproxy users     -c /etc/uniproxy/config.json   # bob should be active
uniproxy validate  -c /etc/uniproxy/config.json
uniproxy generate  -c /etc/uniproxy/config.json -o /var/lib/uniproxy/out
uniproxy apply     -c /etc/uniproxy/config.json --yes
```

预期：`users` 表格出现 bob；apply 后 bob 的订阅 URL 生效。

### 11.2 修改协议/端口/新增入站

1. 编辑 `config.json`
2. `uniproxy validate`（确认端口不冲突）
3. `uniproxy doctor`（确认证书/密钥/内核）
4. `uniproxy generate` → `uniproxy apply --yes`
5. 按步骤 10 复验

### 11.3 升级 uniproxy

```bash
systemctl stop uniproxy-sub
cd /tmp && VERSION=<new-version>
curl -fLO .../uniproxy-${VERSION}-linux-x64
sha256sum -c uniproxy-${VERSION}-linux-x64.sha256
install -m 0755 uniproxy-${VERSION}-linux-x64 /usr/local/bin/uniproxy
uniproxy --help
uniproxy doctor  -c /etc/uniproxy/config.json
uniproxy apply   -c /etc/uniproxy/config.json --yes
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
