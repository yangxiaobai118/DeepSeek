# uniproxy Installation & Deployment Guide

> Version: **0.4.6** · Target OS: Debian 11+ / Ubuntu 20.04+ / Rocky Linux 8+ (glibc ≥ 2.28)
> Audience: operators deploying on a single Linux server
> Examples: domain `example.com`, panels `xui.example.com` / `sui.example.com`, subscriptions `sub.example.com`, Reality SNI `www.bing.com`, server IP written as `<server-ip>`

Quick start, feature list and platform matrix: [repository README](../../README.md). This guide is the detailed walkthrough.

## One-line install (recommended)

Run as root on a fresh Linux server. The installer detects the architecture, downloads the matching release asset (self-contained binary when available, otherwise the Node bundle), installs `uniproxy` / `u-ui`, seeds `/etc/uniproxy/config.json` and writes the systemd units; the panel is reachable once the setup wizard creates an admin account.

```bash
bash <(curl -Ls https://raw.githubusercontent.com/yangxiaobai118/DeepSeek/feature/uniproxy/uniproxy/install.sh)
```

Pin a version by appending the tag number:

```bash
bash <(curl -Ls https://raw.githubusercontent.com/yangxiaobai118/DeepSeek/feature/uniproxy/uniproxy/install.sh) 0.4.6
```

Preview the plan without touching the system:

```bash
UNIPROXY_DRY_RUN=1 bash <(curl -Ls https://raw.githubusercontent.com/yangxiaobai118/DeepSeek/feature/uniproxy/uniproxy/install.sh)
```

Custom ports or paths:

```bash
UNIPROXY_UI_PORT=9000 UNIPROXY_SUB_PORT=9001 UNIPROXY_PREFIX=/opt/uniproxy \
  bash <(curl -Ls https://raw.githubusercontent.com/yangxiaobai118/DeepSeek/feature/uniproxy/uniproxy/install.sh)
```

The menu opens automatically after install; if not, run `u-ui` and choose the setup wizard to fill in the domain, ports and admin password. Other overrides: `UNIPROXY_VERSION`, `UNIPROXY_BIN_DIR`, `UNIPROXY_ETC_DIR`.

### Faster downloads

Release binaries are published raw and gzip-compressed (`*.gz`); the installer prefers the compressed asset, which is roughly a third of the size. On a host that already has Node.js >= 18, `UNIPROXY_MODE=js` downloads the ~50 KiB JS bundle instead of a runtime. When GitHub itself is slow, prefix the URLs with a mirror using `UNIPROXY_MIRROR` (for example `UNIPROXY_MIRROR=https://ghfast.top/`).


This guide follows the **real order of operations**. Every step has four parts:

- **Goal** — what this step does and why it matters
- **Run** — commands to copy or fields to edit
- **Expected result** — what a healthy run looks like
- **If it differs** — the usual causes and fixes

> All commands assume `root`. Otherwise prepend `sudo` or run `sudo -i` first.

---

## 0. Overview

| Step | What you do | Time | Skippable |
|------|-------------|------|-----------|
| 1 | Prepare server, DNS, ports, package | 10 min | no |
| 2 | Install uniproxy (binary or JS package) | 3 min | no |
| 3 | Install Xray, sing-box, nginx | 10 min | no |
| 4 | Prepare TLS certificates | 5–20 min | no (needed for TLS/Reality) |
| 5 | Initialise and edit `config.json` | 10 min | no |
| 6 | `validate` + `doctor` | 2 min | no |
| 7 | `generate` the three configs | 1 min | no |
| 8 | `apply --yes` installs and restarts | 3 min | no |
| 9 | Start the subscription service (optional) | 5 min | yes |
| 10 | Acceptance: ports, TLS, panels, subscriptions, clients | 5 min | no |

End-to-end:

```
prepare server → install uniproxy → install cores → certificates
        → init config → validate/doctor → generate
        → apply (validate + backup + install + reload) → serve → acceptance
```

### 0.1 Placeholder conventions (read before copying)

The values below are **not literals** — they are placeholders you must replace. Copying an example as-is will usually fail:

| In the code | Replace with | Why it matters | If you copy it as-is |
|---|---|---|---|
| `example.com`, `www.example.com`, `xui.example.com`, `sui.example.com`, `sub.example.com` | your real domain and subdomains | certificates, nginx `server_name`, 443 SNI routing and subscription URLs all match on it | certificate issuance fails, panels unreachable, subscriptions 404 |
| `www` / `xui` / `sui` / `sub` (e.g. `for d in www xui sui sub`) | the subdomain prefixes you planned; add or remove as needed | the loop builds `$d.example.com` to check DNS | you resolve the example domains, so an IP in the output proves nothing about your own DNS |
| `<server-ip>` | the server public IP | client links, `server.publicIp` and acceptance commands use it | links point at a placeholder and clients cannot connect |
| `203.0.113.10` | the real public IP | it is an RFC 5737 example range, not your IP | `validate` fails with `server.publicIp still a placeholder` |
| `<version>`, `0.4.6` | the actual release version | download URLs, asset names and install paths include it | download 404 |
| `<service>` | the real unit name: `xray` / `sing-box` / `nginx` / `uniproxy-sub` | `journalctl -u` filters by unit name | no logs, and you may think there were no errors |
| `<target>`, `<timestamp>` | the backed-up file and its timestamp | `apply` writes `.bak-<timestamp>` | you cannot find the backup to roll back |
| `<uuid>`, `TOKEN=xxxx...` | the UUID from `uniproxy users`, the subscription token | client credentials and subscription auth | auth fails, subscription 403 |
| `10.0.0.0/8`, `corp.example.org`, `ads.example.net` | your own networks and domains | configuration examples only | starts fine, but routing follows the example |

> **Rule: commands are copy-pasteable, but the values above must be replaced first.** Do not run DNS, certificate or `apply` commands before replacing them — the half-configured state is hard to debug.
>
> Also run code blocks **line by line**: pasting a whole block may collapse the newlines into one line and fail.

### 0.2 Working-directory conventions

Commands in this guide start in **`/root`** (root home) and are meant to run **in one shell, in order**.

- Wherever a step needs a specific directory it writes `cd` explicitly and states **which directory you end up in**.
- `cd` only affects the current shell. If you open a new terminal or start a new `sudo -i` session, go back to the documented directory first.
- Most steps use absolute paths (`/etc/uniproxy/...`) and do not care about the current directory; only the tar-package and certificate steps do, and those are called out explicitly.

---

## 1. Step 1: Preparation

### Goal

Confirm the server meets the requirements, DNS points at it, ports 80/443 are free, and pick the right package.

### Run

**1.1 Check the OS and architecture**

```bash
uname -m
cat /etc/os-release | head -3
df -h / | tail -1
ss -lntp | grep -E ':(80|443)\b' || echo "80/443 free"
```

**1.2 DNS records**

| Name | Purpose |
|------|---------|
| `www.example.com` | website |
| `xui.example.com` | x-ui panel (optional) |
| `sui.example.com` | s-ui panel (optional) |
| `sub.example.com` | subscriptions |

```bash
for d in www xui sui sub; do echo -n "$d.example.com -> "; dig +short $d.example.com; done
```

> **What to replace**: `example.com` with your domain, and `www xui sui sub` with your subdomain prefixes. `dig` only queries and changes nothing — but replace first, otherwise you are resolving the example domain and an IP in the output proves nothing about your own DNS.

**1.3 Open the firewall**

```bash
ufw allow 80/tcp && ufw allow 443/tcp   # Debian/Ubuntu
# firewall-cmd --permanent --add-service={http,https} && firewall-cmd --reload   # Rocky
```

**1.4 Pick the package** — prefer the standalone binary (no Node.js needed on the server).

| `uname -m` | Asset |
|------------|-------|
| `x86_64` | `uniproxy-<version>-linux-x64` |
| `aarch64` | `uniproxy-<version>-linux-arm64` |
| `ppc64le` | `uniproxy-<version>-linux-ppc64le` |
| `s390x` | `uniproxy-<version>-linux-s390x` |
| Alpine (musl) | `uniproxy-<version>-linux-musl-x64` |

> There is no 32-bit Linux/Windows binary: Node.js no longer publishes 32-bit runtimes. Use the JS package with Node.js ≥ 18 there.

### Expected result

- Architecture is `x86_64` or `aarch64`
- Debian 11+/Ubuntu 20.04+/Rocky 8+
- All four names resolve to `<server-ip>`
- Ports are free (prints `80/443 free`)

### If it differs

- No DNS answer: wait for propagation; disable Cloudflare proxying (grey cloud) before ACME.
- Ports busy: inspect `ss -lntp` and stop old apache/nginx/caddy.

---

## 2. Step 2: Install uniproxy

### Goal

Install the `uniproxy` command into `/usr/local/bin`; everything else is generated by it.

### Run

**Option A: standalone binary (recommended)**

The four steps below run in the **same shell**. Each step is a single line, so copying a line always works.

Step 1: enter a working directory and set the version

```bash
cd /tmp && VERSION=0.4.6
```

> **What to replace**: set `VERSION` to the release you are installing (the example is the current one), and make the asset name `uniproxy-${VERSION}-linux-x64` match `uname -m` (`linux-x64` for x86_64, `linux-arm64` for aarch64 — see the table in 1.4). A wrong version or asset name returns 404.

Step 2: download the binary and its checksum

```bash
curl -fLO "https://github.com/yangxiaobai118/DeepSeek/releases/download/uniproxy-v${VERSION}/uniproxy-${VERSION}-linux-x64" && curl -fLO "https://github.com/yangxiaobai118/DeepSeek/releases/download/uniproxy-v${VERSION}/uniproxy-${VERSION}-linux-x64.sha256"
```

Step 3: verify integrity (an `OK` line must appear before you continue)

```bash
sha256sum -c uniproxy-${VERSION}-linux-x64.sha256
```

Step 4: install and check

```bash
install -m 0755 uniproxy-${VERSION}-linux-x64 /usr/local/bin/uniproxy && uniproxy --help
```

> **About the install directory**: `/tmp` is only a scratch directory for the download - you can throw it away afterwards, or use `cd /root` instead. What actually matters is where the executable lives. To skip the manual steps, use the terminal menu entry **1. Install to system paths**: it puts the program in `/usr/local/uniproxy`, creates `uniproxy` and `u-ui` in `/usr/local/bin`, and writes the systemd units - the same layout 3x-ui uses under `/usr/local/x-ui`.

> **Copying tip**: every step is one line, so line-by-line copying always works. If pasting a multi-line block collapses it into a single line and you get `cd: too many arguments`, your terminal lost the newlines; a `#` comment also swallows the rest of a collapsed line, which is why this guide keeps explanations in prose instead of between commands.

**Option B: JS package (Node.js ≥ 18)**

Reuses `VERSION` from step 1; run in the same shell:

```bash
curl -fLO "https://github.com/yangxiaobai118/DeepSeek/releases/download/uniproxy-v${VERSION}/uniproxy-${VERSION}.tgz"
```

```bash
npm install -g ./uniproxy-${VERSION}.tgz && uniproxy --help
```

To run it without a global install:

```bash
tar -xzf uniproxy-${VERSION}.tgz && node uniproxy/src/index.js --help
```

**Create runtime directories**

```bash
mkdir -p /etc/uniproxy/certs /var/lib/uniproxy /var/log/uniproxy
```

> **Directory note**: after `cd /tmp` in step 1, every download and extraction in this section happens in `/tmp`, and **you stay in `/tmp` when the section ends**. The `mkdir` below uses absolute paths, so it does not depend on the current directory.

### Expected result

- `sha256sum -c` prints `uniproxy-0.4.6-linux-x64: OK`
- `uniproxy --help` prints:

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

### If it differs

- `404`: wrong version or asset name; check the release page and adjust the URL.
- Checksum error: download the `.sha256` file again.
- `Permission denied`: use `sudo` or confirm `/usr/local/bin` exists.
- `GLIBC_2.28 not found`: OS too old; use the JS package with a newer Node.

---

## 3. Step 3: Install Xray, sing-box and nginx

### Goal

uniproxy only generates and installs configuration; Xray and sing-box carry proxy traffic, nginx terminates TLS and multiplexes :443 by SNI.

> **Directory note**: this section runs in `/tmp`, where step 2 left you. 3.1 (Xray) and 3.3 (nginx) use absolute paths and do not depend on the current directory; 3.2 (sing-box) runs `cd /tmp` explicitly and leaves you there.

### 3.0 Already installed? Check first (this whole section can be skipped)

uniproxy never reads binaries from `/tmp`: it calls `xray` / `sing-box` / `nginx` through **PATH** and restarts/reloads units by **systemd unit name**. Installed cores are taken over as they are - but first confirm **whether they are installed and running**.

Run these two:

```bash
xray version; sing-box version; nginx -v
```

```bash
systemctl is-active xray sing-box nginx
```

**Read your output and pick the matching row:**

| What you see | Meaning | What to do |
|---|---|---|
| all three versions print and all units are `active` | installed and running | **skip 3.1-3.3 and go to step 4** |
| a command is `command not found` and its unit is `inactive` | not installed, or installed inside a panel directory and not on PATH | see **3.0.1** below: decide who owns the cores first, then install |
| the version prints but the unit is `inactive` | installed but not started | `systemctl enable --now xray` (same for sing-box; use `nginx` for nginx) |
| nginx `active`, xray and sing-box both `command not found` | most common: only nginx installed | **do 3.1 and 3.2 only, skip 3.3** |
| the version prints but fails with `GLIBC_2.28 not found` | OS too old | use the JS package with a newer Node (see 1.4) |

> For example, `nginx version: nginx/1.30.8` prints while `xray` and `sing-box` are `command not found` and their units are `inactive`: **nginx is ready, Xray and sing-box are not installed** -> do 3.1 and 3.2, skip 3.3.

**What does "put the binary in `/usr/local/bin`" mean?**

It means copying the **executable file** (for example `xray` or `sing-box`) into the `/usr/local/bin` directory - the shell looks for commands there automatically, so after copying you can just type `xray`.

**You do not need to do this by hand**:

- the official installer in 3.1 already installs to `/usr/local/bin` and creates the unit;
- `install -m 0755 ... /usr/local/bin/sing-box` in 3.2 is exactly "putting the binary there".

You only need to do it manually when you **already have an executable from somewhere else** (a file you were given, or something extracted into `/opt`). The easiest way is a shortcut (symlink):

```bash
ln -s /opt/xray/xray /usr/local/bin/xray
```

(Replace `/opt/xray/xray` with the real path; after that `xray` points to it. A symlink is just a shortcut.)

**If the unit name is not the default** (for example `my-xray`), `systemctl restart xray` will fail; override it in `config.json`:

```json
"apply": {
  "validate": { "xray": "/opt/xray/xray run -test -c {file}" },
  "reload":   { "xray": "systemctl restart my-xray" }
}
```

> **What happens when something is missing**: `apply` first runs the validators against the generated configs (`xray run -test` / `sing-box check` / `nginx -t`); **if a command does not exist the validation fails and `apply` aborts before writing any file**. So do not run `apply` until the checks above pass; if you deliberately have no validator, `--skip-validate` exists but is not recommended.

### 3.0.1 Already running 3x-ui / s-ui?

3x-ui and s-ui **ship their own core** (3x-ui bundles Xray, s-ui bundles sing-box) and start it themselves. The core usually lives inside the panel directory (for example `/usr/local/x-ui/bin/`, `/usr/local/s-ui/bin/`) and is **not on PATH**, so `xray version` / `sing-box version` report `command not found` even though it is installed.

**Do not let both sides manage the core**: the panel writes its own config and starts the core, while uniproxy `apply` also writes a config and runs `systemctl restart xray` / `sing-box`; they overwrite each other and fight for the same port. Pick one mode first:

**Mode A: let uniproxy own it (recommended if you want its config generation, subscriptions and doctor)**

1. Stop the panels so they release their ports:

```bash
systemctl disable --now x-ui s-ui
```

2. Install the official cores via 3.1 / 3.2 - they create the `xray` / `sing-box` systemd units that `apply` needs.
3. Continue with step 4. Inbounds, users and subscriptions are then managed by `config.json`.

> You can leave the panel cores installed but unused. Do not symlink one to `xray` and expect `systemctl restart xray` to work - the panel never created a unit with that name.

**Mode B: panels keep the cores, uniproxy only does nginx / 443**

1. Keep the panels running.
2. Disable both cores in `config.json`:

```json
"xray":    { "enabled": false },
"singbox": { "enabled": false }
```

3. `apply` then only writes nginx; no core config is generated or restarted.
4. For `nginx.mode: "stream"`, fill `sni` and ports from the inbounds **actually configured in the panels**, or :443 will forward to a dead port.

> Also make sure the panels are not holding 80/443: `ss -lntp | grep -E ':(80|443)\b'`.

### 3.1 Xray-core

This step does not depend on the current directory (the installer uses absolute paths) and leaves you in `/tmp`.

Step 1: install Xray (the script also creates the systemd unit)

```bash
bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install
```

Step 2: verify

```bash
xray version && systemctl is-active xray
```

### 3.2 sing-box

Step 1: enter `/tmp` and set the version

```bash
cd /tmp && SB=1.14.5
```

> **What to replace**: `SB` with the latest stable sing-box release, and `linux-amd64` with your architecture (`linux-amd64` for x86_64, `linux-arm64` for aarch64). This step runs `cd /tmp` explicitly and leaves you there.

Step 2: download and extract

```bash
curl -fLO "https://github.com/SagerNet/sing-box/releases/download/v${SB}/sing-box-${SB}-linux-amd64.tar.gz" && tar -xzf "sing-box-${SB}-linux-amd64.tar.gz"
```

Step 3: install and verify

```bash
install -m 0755 "sing-box-${SB}-linux-amd64/sing-box" /usr/local/bin/sing-box && sing-box version
```

Step 4: create the config directory

```bash
mkdir -p /usr/local/etc/sing-box
```

Create `/etc/systemd/system/sing-box.service`:

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

### 3.3 nginx (needs the stream module)

This step uses absolute paths and leaves you in `/tmp`. On Rocky / AlmaLinux replace the first command with `dnf install -y nginx`.

```bash
apt update && apt install -y nginx
```

```bash
nginx -V 2>&1 | grep -o -- --with-stream
```

```bash
cp /etc/nginx/nginx.conf "/etc/nginx/nginx.conf.dist-$(date +%F)"
```

> `apply` replaces `/etc/nginx/nginx.conf` entirely (default target, configurable as `apply.nginxConfig`). The backup above lets you restore the distro configuration.

### Expected result

- `xray version` prints `Xray 25.x`
- `sing-box version` prints `sing-box version 1.14.x`
- `nginx -V` output contains `--with-stream`
- All three commands are on `PATH`

### If it differs

- `xray: command not found`: rerun the install script and read its output.
- No `--with-stream`: use an nginx build with the stream module, or switch to `nginx.mode: "http"` (not recommended).
- sing-box may fail to start until step 8 writes its config; that is expected.

---

## 4. Step 4: Certificates

### Goal

nginx, Xray TLS inbounds and sing-box TLS inbounds share one certificate pair:

```
/etc/uniproxy/certs/fullchain.pem   # leaf + intermediates
/etc/uniproxy/certs/privkey.pem     # private key
```

### Option A: existing certificate (recommended)

Upload `fullchain.pem` and `privkey.pem` to any directory on the server (the example uses `/root/certs`), then **enter that directory** before running the commands below — `install` reads both files from the current directory. You stay in that directory afterwards; later steps use absolute paths and are unaffected.

Step 1: enter the certificate directory (adjust to your real path)

```bash
cd /root/certs
```

Step 2: copy into the uniproxy certificate directory and fix permissions

```bash
install -m 0644 fullchain.pem /etc/uniproxy/certs/fullchain.pem && install -m 0600 privkey.pem /etc/uniproxy/certs/privkey.pem && chown root:root /etc/uniproxy/certs/*
```

Step 3: verify the certificate

```bash
openssl x509 -in /etc/uniproxy/certs/fullchain.pem -noout -subject -dates
```

The certificate must cover every public name (`www/xui/sui/sub` and TLS inbound SNIs). A wildcard `*.example.com` covers them at once.

### Option B: Let's Encrypt DNS-01 (wildcard capable)

```bash
apt install -y certbot
certbot certonly --manual --preferred-challenges dns \
  -d example.com -d '*.example.com'
# add the TXT record as prompted

install -m 0644 /etc/letsencrypt/live/example.com/fullchain.pem /etc/uniproxy/certs/fullchain.pem
install -m 0600 /etc/letsencrypt/live/example.com/privkey.pem  /etc/uniproxy/certs/privkey.pem
```

> **What to replace**: both `example.com` occurrences with your domain. `-d '*.example.com'` requests a wildcard covering `www` / `xui` / `sui` / `sub` and any other subdomain. certbot will ask for a TXT record — add it and wait for propagation before pressing enter, or issuance fails. The `install` paths below must use your real domain too.

> Automatic renewal is out of scope here. For production, use a DNS plugin plus a deploy hook that copies the files and reloads nginx.

### Option C: Let's Encrypt HTTP-01 (port 80 free)

```bash
systemctl stop nginx
certbot certonly --standalone -d www.example.com -d xui.example.com -d sui.example.com -d sub.example.com
systemctl start nginx
```

> **What to replace**: all four `-d` values with your real domains (site + two panels + subscription). HTTP-01 needs port 80 reachable from the internet, hence stopping nginx around it. Do not keep `example.com`.

### Expected result

```
subject=CN = example.com
notBefore=... notAfter=... (in the future)
```

> Note: **sample output**. `subject=CN` shows your own domain and `notAfter` is the real expiry.

### If it differs

- `unable to load certificate`: not PEM or truncated.
- Key must be mode 600 owned by root; nginx runs as root at master level.
- HTTP-01 fails behind Cloudflare proxy: use DNS-01 or disable the proxy temporarily.

---

## 5. Step 5: Initialise and edit the config

### Goal

Create a config with fresh Reality keys, UUIDs and `server.secret`, then fill in your real values.

### Run

```bash
uniproxy init -c /etc/uniproxy/config.json
```

Expected output:

```
created /etc/uniproxy/config.json with freshly generated Reality keypair + UUIDs
next: edit server.publicIp / domains / cert paths, then run "uniproxy validate"
```

Edit `/etc/uniproxy/config.json`:

| Field | Set to | Notes |
|-------|--------|-------|
| `server.publicIp` | `<server-ip>` | address inside client links |
| `server.email` | your email | contact |
| `server.secret` | **keep the generated value** | derives user credentials; treat as a secret |
| `server.cert.certFile` | `/etc/uniproxy/certs/fullchain.pem` | matches step 4 |
| `server.cert.keyFile` | `/etc/uniproxy/certs/privkey.pem` | idem |
| `panels.xui.enabled` | `false` if x-ui is not installed | otherwise nginx returns 502 |
| `panels.xui.domain` | `xui.example.com` | panel hostname |
| `panels.sui.enabled` / `domain` | same | s-ui |
| `panels.sui.sub` | keep only if s-ui subscriptions are used | else `"sub": { "enabled": false }` |
| `nginx.mode` | `stream` (recommended) | nginx multiplexes :443 by SNI |
| `nginx.sites[0].serverName` | `www.example.com` | website |
| `nginx.sites[0].root` | `/var/www/html` | must contain index.html |
| `nginx.extraSites` | see step 9 | subscription hostname to 127.0.0.1:8787 |
| `xray.inbounds[0].sni` | a real site, e.g. `www.bing.com` | must equal `reality.serverNames` |
| `xray.inbounds[0].port` | `10443` (keep 127.0.0.1) | reached through nginx :443 |
| `xray.inbounds[0].clients` | your UUID/name pairs | or use the top-level `users` |
| `singbox.inbounds[0].sni` | `sb.example.com` (covered by cert) | or another covered name |
| `subscription.publicBase` | `https://sub.example.com` | subscription URL prefix |
| `subscription.routing` | optional | direct/block/bypass-LAN rules |
| `apply.xrayConfig` | `/usr/local/etc/xray/config.json` | default is fine |
| `apply.singboxConfig` | `/usr/local/etc/sing-box/config.json` | default is fine |
| `apply.nginxConfig` | `/etc/nginx/nginx.conf` | **must match the file nginx actually loads** |
| `apply.reload` | defaults: `systemctl restart/reload` | change only for custom services |

**User example** (top-level `users`, one user on both cores):

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

> **What to replace**: `alice` with your user name, `inbounds` with the inbound `tag`s you want to provision (see `xray.inbounds` / `singbox.inbounds` in `config.json`), and adjust or drop `expireAt` / `dataLimitBytes` (dropping means unlimited). Paste this into the `users` array of `config.json`; it is not a command.

> Listing `inbounds` provisions alice into those inbounds; credentials are derived deterministically from `server.secret` (UUID for VLESS/VMess, password for Trojan), so regenerating never rotates them.

### Expected result

- File exists and is valid JSON
- `server.secret` is a long random string
- Every `example.com` is replaced or the feature is disabled

### If it differs

- `refusing to overwrite existing`: back up and remove the old file, or edit it directly.
- JSON errors: run `python3 -m json.tool /etc/uniproxy/config.json > /dev/null`.

---

## 6. Step 6: Validate and pre-flight

### Goal

Find configuration, port and certificate problems before touching the system.

### Run

```bash
uniproxy validate -c /etc/uniproxy/config.json
uniproxy doctor   -c /etc/uniproxy/config.json
```

### Expected result

`validate`:

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

`doctor` (one line per check, summary at the end):

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

> Note: **sample output**. `203.0.113.10` is the example IP; your run prints the real `server.publicIp`. A `FAIL ... still a placeholder` line means it is not replaced yet.

> `doctor` exits 1 on FAIL and 0 with warnings only.

### If it differs

| Output | Meaning | Fix |
|--------|---------|-----|
| `ERROR port 443 is claimed by ...` | two components share a port | change ports in `config.json` |
| `FAIL server.publicIp still a placeholder` | still 203.0.113.x | set the real IP |
| `FAIL reality key` | privateKey is not 32-byte base64url | re-run `init` |
| `WARN certificate ... not readable` | file missing locally | finish step 4 |
| `WARN binary xray not runnable` | core not installed | finish step 3 |
| `ERROR duplicate inbound tag` | tag reused | rename it |

---

## 7. Step 7: Generate configs (no system changes)

### Goal

Expand `config.json` into native Xray / sing-box / nginx configs, client links and subscription files — inspect before installing.

### Run

```bash
uniproxy generate -c /etc/uniproxy/config.json -o /var/lib/uniproxy/out
```

### Expected result

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

> Note: **sample output**. `alice` is the user name and `<token>` is the generated subscription token; both follow your own config.

```bash
ls -R /var/lib/uniproxy/out
sed -n '1,40p' /var/lib/uniproxy/out/SUMMARY.md
head -2 /var/lib/uniproxy/out/links.txt
```

`SUMMARY.md` contains the port map, generated files, subscription URLs and links.

### If it differs

- `fix errors before generating`: configuration still invalid; repeat step 6.
- Nothing written: check write permission on `/var/lib/uniproxy`.

> `generate` only writes the output directory; it is safe to run repeatedly.

---

## 8. Step 8: Install and restart services

### Goal

Install the three configs, validate them, back up the old files, write the new ones and reload the services. `apply` validates first, backs up, and rolls back on failure.

### Run

**Dry run first (writes nothing)**

```bash
uniproxy apply -c /etc/uniproxy/config.json
```

Expected:

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

**Apply**

```bash
uniproxy apply -c /etc/uniproxy/config.json --yes
```

### Expected result

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

Then check:

```bash
systemctl is-active xray sing-box nginx
ss -lntp | grep -E ':(80|443|8443)\b'
```

Expected: all three `active`; nginx listens on 80/443/8443; the cores listen on 10443/2052 bound to `127.0.0.1`.

### If it differs

- Any `FAIL`: execution stops before writing further targets; files already written are restored from backup (`restored previous configs`).
- `xray run -test` fails: fix `config.json` (Reality parameters or flow).
- `nginx -t` fails: usually a missing certificate path, mismatched key, or a busy port.
- `reload failed`: inspect `journalctl -u <service> -n 50`, fix, re-run.
- `--skip-validate` / `--skip-reload` exist but are not recommended.
- Manual rollback: `apply` keeps `<target>.bak-<timestamp>`.

---

## 9. Step 9: Start the subscription service (optional)

### Goal

Give clients one URL that returns every node (base64 links, sing-box JSON, Clash YAML).

### Option A: built-in subscriptions (recommended)

Create `/etc/systemd/system/uniproxy-sub.service`:

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

Add the public entry in `config.json`:

```json
"nginx": {
  "mode": "stream",
  "extraSites": [
    { "serverName": "sub.example.com", "upstream": "127.0.0.1:8787" }
  ]
}
```

> **What to replace**: `sub.example.com` with your subscription domain, and keep `127.0.0.1:8787` in sync if you changed the `serve` port. Merge this into the `nginx` section of `config.json`; it is not a command.

```bash
uniproxy apply -c /etc/uniproxy/config.json --yes
```

### Option B: s-ui subscriptions

If s-ui is installed and `panels.sui.sub` is enabled (port 2096), nginx already proxies `sub.example.com`. Use the links from s-ui. **Pick one option only** to avoid duplicate hostnames.

### Expected result

- `uniproxy-sub` is `active (running)`
- `curl http://127.0.0.1:8787/api/state` returns JSON
- `https://sub.example.com/sub/<token>` is reachable (verified in step 10)

### If it differs

- 8787 busy: change `-p` and the `extraSites.upstream` together.
- Hostname added but still old behaviour: you did not run `apply` again.
- 502: `uniproxy-sub` is down; check `journalctl -u uniproxy-sub -n 30`.

---

## 10. Step 10: Acceptance

### 1) Services and ports

```bash
systemctl is-active xray sing-box nginx uniproxy-sub
ss -lntp | grep -E ':(80|443|8443|10443|2052|8787)\b'
```

Expected: all `active`; 80/443/8443 owned by nginx; 10443/2052/8787 bound to `127.0.0.1`.

### 2) Website and TLS

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://www.example.com
curl -sSI https://www.example.com | head -5
openssl s_client -connect www.example.com:443 -servername www.example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -dates
```

> **What to replace**: all three `www.example.com` occurrences with your site domain. Expect `200` or `301/302` from `%{http_code}`; `-servername` must match the domain or SNI routing picks another backend.

Expected: HTTP 200/301; certificate subject matches and is valid.

### 3) Panels

```bash
curl -sS -o /dev/null -w 'xui=%{http_code}\n' https://xui.example.com
curl -sS -o /dev/null -w 'sui=%{http_code}\n' https://sui.example.com
```

> **What to replace**: `xui.example.com` / `sui.example.com` with your panel domains. `200/302` is healthy; `502` means the panel is down or the upstream port is wrong.

Expected: 200/302. If a panel is not installed, set `enabled: false`, otherwise nginx returns 502.

### 4) Client links

```bash
uniproxy links -c /etc/uniproxy/config.json | head -3
```

Expected:

```
vless://<uuid>@<server-ip>:443?encryption=none&type=tcp&security=reality&sni=www.bing.com&fp=chrome&pbk=...&sid=...&flow=xtls-rprx-vision#xray-vless-reality-alice
```

> Note: this is **sample output**. `<uuid>`, `<server-ip>` and `pbk=...` become real values on your own run — do not copy them literally.

### 5) Subscriptions

```bash
uniproxy subscribe -c /etc/uniproxy/config.json
```

Expected: three URLs per client (`links`, `json`, `clash`). Verify one token:

```bash
TOKEN=xxxxxxxxxxxxxxxxxxxxxxxx
curl -fsS "https://sub.example.com/sub/${TOKEN}" | base64 -d | head -2
curl -sSI "https://sub.example.com/sub/${TOKEN}" | grep -iE 'subscription-userinfo|profile-title|cache-control'
```

> **What to replace**: `TOKEN` with the real token from `uniproxy subscribe` (the `links`, `json` and `clash` URLs share it), and `sub.example.com` with your subscription domain. The endpoint authenticates by token, so the placeholder only yields 404 / 403.

Expected: decoded `vless://...`; headers include `profile-title`, `cache-control: no-store`, and `subscription-userinfo` when the user has quota/expiry.

### 6) Import into clients

- **v2rayN / NekoBox / Shadowrocket**: the `/sub/<token>` (base64 links) URL
- **sing-box**: `/sub/<token>/json`
- **Clash / Mihomo**: `/sub/<token>/clash`

Then measure latency and browse to confirm the proxy works.

### If it differs

| Symptom | Check |
|---------|-------|
| :443 refuses connections | nginx active? firewall/security group open? |
| TLS error | certificate covers the name? `openssl` check |
| Links import but fail | Reality key/shortId/SNI mismatch; check Xray logs |
| Subscription 404 | wrong token or `uniproxy-sub` down |
| Subscription 403 | user expired/over quota/disabled (`uniproxy users`) |
| Panel 502 | panel down, wrong port, or hostname missing from the stream map |

---

## 11. Routine operations

### 11.1 Add a user

Edit the `users` array in `/etc/uniproxy/config.json`:

```json
{ "name": "bob", "inbounds": ["xray-vless-reality", "sb-vless-ws-tls"], "expireAt": "2027-06-01T00:00:00Z" }
```

> **What to replace**: `bob` with the new user name, `inbounds` with the inbound `tag`s to provision, and adjust `expireAt`. Append this object to the `users` array in `config.json`.

```bash
uniproxy users     -c /etc/uniproxy/config.json   # bob should be active
uniproxy validate  -c /etc/uniproxy/config.json
uniproxy generate  -c /etc/uniproxy/config.json -o /var/lib/uniproxy/out
uniproxy apply     -c /etc/uniproxy/config.json --yes
```

> **What to replace**: `bob` in the comment with the user you just added; the following `validate` / `generate` / `apply` use the same `config.json`, so change the path consistently if yours differs.

Expected: bob appears in the table; his subscription works after apply.

### 11.2 Change protocols, ports or add inbounds

1. Edit `config.json`
2. `uniproxy validate` (port conflicts)
3. `uniproxy doctor` (certificates/keys/cores)
4. `uniproxy generate` → `uniproxy apply --yes`
5. Re-run the acceptance checks

### 11.3 Upgrade uniproxy

Downloads, checksum and install all happen in `/tmp` (step 2 runs `cd /tmp` explicitly); you stay in `/tmp`, and `doctor` / `apply` use absolute paths.

Step 1: stop the subscription service

```bash
systemctl stop uniproxy-sub
```

Step 2: enter `/tmp` and set the new version

```bash
cd /tmp && VERSION=<new-version>
```

> **What to replace**: `<new-version>` with the target version; the asset name below must match your architecture (`linux-x64` for x86_64, `linux-arm64` for aarch64). Stopping `uniproxy-sub` first and running `doctor` + `apply` afterwards avoids new binaries running against old config.

Step 3: download and verify

```bash
curl -fLO "https://github.com/yangxiaobai118/DeepSeek/releases/download/uniproxy-v${VERSION}/uniproxy-${VERSION}-linux-x64" && curl -fLO "https://github.com/yangxiaobai118/DeepSeek/releases/download/uniproxy-v${VERSION}/uniproxy-${VERSION}-linux-x64.sha256" && sha256sum -c uniproxy-${VERSION}-linux-x64.sha256
```

Step 4: install and verify

```bash
install -m 0755 uniproxy-${VERSION}-linux-x64 /usr/local/bin/uniproxy && uniproxy --help
```

Step 5: pre-flight, install, then restart the subscription service

```bash
uniproxy doctor -c /etc/uniproxy/config.json && uniproxy apply -c /etc/uniproxy/config.json --yes
```

```bash
systemctl start uniproxy-sub
```

Expected: services back; apply keeps timestamped backups.

### 11.4 Backups

| Path | Content |
|------|---------|
| `/etc/uniproxy/` | main config + certificates |
| `/etc/nginx/nginx.conf` | generated nginx config |
| `/usr/local/etc/xray/config.json` | Xray config |
| `/usr/local/etc/sing-box/config.json` | sing-box config |
| `/etc/systemd/system/*.service` | unit files |

```bash
tar -czf /root/uniproxy-backup-$(date +%F).tar.gz \
  /etc/uniproxy /etc/nginx/nginx.conf /usr/local/etc/xray /usr/local/etc/sing-box
```

### 11.5 Logs

```bash
journalctl -u xray -n 50 --no-pager
journalctl -u sing-box -n 50 --no-pager
journalctl -u nginx -n 50 --no-pager
journalctl -u uniproxy-sub -n 50 --no-pager
tail -n 50 /var/log/nginx/error.log
```

---

## 12. Troubleshooting quick reference

| Symptom | Cause | Fix |
|---------|-------|-----|
| `validate` port conflict | two components on one port | change ports in `config.json` |
| apply validation failed | generated config invalid | run the printed command manually and read the error |
| :443 drops after apply | nginx reload failed | `nginx -t`, inspect `journalctl -u nginx`, restore `.bak-*` |
| Website/panel 502 | service down or wrong port | `ss -lntp`, correct the config |
| Reality handshake fails | key/shortId mismatch, SNI not in serverNames | `doctor`; regenerate the keypair |
| Subscription 403 | user expired/quota/disabled | `uniproxy users` and adjust |
| Subscription 404 | bad token or service down | re-run `subscribe`; check `uniproxy-sub` |
| Connected but no traffic | outbound blocked or DNS | test `curl -I https://www.google.com` on the server |
| nginx proxy blocked by SELinux | default policy on RHEL | `setsebool -P httpd_can_network_connect 1` |
| Certificate expired | no renewal | reissue and `systemctl reload nginx` |
| `doctor` says cert unreadable | permissions/path | `ls -l /etc/uniproxy/certs` |

---

## 13. Uninstall

> Back up certificates and configs first; the commands below delete data.

```bash
systemctl disable --now xray sing-box nginx uniproxy-sub

rm -f /etc/systemd/system/uniproxy-sub.service
systemctl daemon-reload

rm -f /usr/local/bin/uniproxy /usr/local/bin/sing-box
bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ remove

rm -rf /etc/uniproxy /usr/local/etc/xray /usr/local/etc/sing-box /var/lib/uniproxy
```

To remove nginx as well: `apt purge -y nginx nginx-common` (removes `/etc/nginx`).

---

## Appendix A: systemd units

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

## Appendix B: Command reference

| Command | Purpose | Common flags |
|---------|---------|--------------|
| `uniproxy init` | create a config with fresh secrets | `-c` |
| `uniproxy validate` | schema, protocol/transport, port checks | `-c` |
| `uniproxy doctor` | certificates, keys, cores, users | `-c`, `--json`, `--no-probe` |
| `uniproxy generate` | write configs, links, subscriptions | `-c`, `-o` |
| `uniproxy apply` | validate + backup + install + reload | `-c`, `--yes`, `--skip-validate`, `--skip-reload` |
| `uniproxy links` | print client links | `-c`, `--client`, `--json` |
| `uniproxy subscribe` | print subscription URLs | `-c`, `--json` |
| `uniproxy users` | user list, status, quota | `-c`, `--json` |
| `uniproxy ports` | print the port map | `-c` |
| `uniproxy serve` | dashboard + subscription HTTP server | `-c`, `-p` |

## Appendix C: Ports

| Port | Component | Listen | Notes |
|------|-----------|--------|-------|
| 80 | nginx | 0.0.0.0 | HTTP→HTTPS redirect / ACME |
| 443 | nginx (stream) | 0.0.0.0 | SNI multiplexer |
| 8443 | nginx (internal TLS) | 127.0.0.1 | website/panel vhosts |
| 10443 | Xray Reality | 127.0.0.1 | reached via :443 SNI |
| 2052 | sing-box WS+TLS | 127.0.0.1 | reached via :443 SNI |
| 2095 | s-ui panel | 127.0.0.1 | nginx reverse proxy |
| 2096 | s-ui subscriptions | 127.0.0.1 | nginx reverse proxy |
| 54321 | x-ui panel | 127.0.0.1 | nginx reverse proxy |
| 8787 | uniproxy serve | 127.0.0.1 | dashboard + subscriptions |

---

> Security note: use this project only for personal learning and lawful self-hosted infrastructure. Keep `server.secret`, Reality private keys, certificate keys and subscription tokens safe.