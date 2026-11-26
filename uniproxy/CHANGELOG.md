# Changelog

## 0.3.2

### Fixed

- `apply` used each target's **validator** command as its reload command, so
  `--yes` never restarted the services. Reload now uses
  `systemctl restart xray`, `systemctl restart sing-box` and
  `systemctl reload nginx` (or the `apply.reload` overrides).
- The default `apply.nginxConfig` is now `/etc/nginx/nginx.conf`, matching the
  configuration file that `systemctl reload nginx` actually loads.

### Added

- `docs/INSTALL.zh-CN.md`: end-to-end installation manual covering package
  choice, core installation, certificates, configuration, `validate`/`doctor`,
  `generate`, `apply`, subscriptions, acceptance checks, routine operations,
  troubleshooting and uninstall.

## 0.3.1

### Added

- Platform-labelled release bundles: Linux (`x86_64`, `i386`, `arm64`,
  `armv7l`, `armv6l`, `s390x`, `ppc64le`), Windows (`x86_64`, `i386`,
  `arm64`) and macOS (`x86_64`, `arm64`), plus the platform-neutral npm
  tarball.
- `ENVIRONMENT.txt` inside every bundle: target OS/architecture, bitness,
  matching Node.js build, launcher and install commands.
- `PLATFORMS.md` release asset and README matrix mapping each archive to its
  environment.
- Standalone single-file binaries built with Node.js SEA (embedded runtime, no
  Node.js installation) for linux-x64, linux-arm64, linux-ppc64le, linux-s390x,
  linux-musl-x64, win-x64, win-arm64, darwin-x64 and darwin-arm64, each with a
  `.sha256` file and a `BINARIES.md` manifest.
- `scripts/package.mjs` builds the matrix with sh / cmd / ps1 launchers and
  writes per-asset `.sha256` files plus `SHA256SUMS.txt`.
- The release workflow rebuilds everything on every push to
  `feature/uniproxy` (or manual dispatch), verifies the Linux bundle on a
  real filesystem (`--help`, `init`, `validate`, executable launcher, LF),
  refreshes the release and prunes stale assets.

### Notes

- uniproxy is pure JavaScript: every bundle carries the same code and no
  compiled binaries. The OS/architecture suffix identifies the target
  environment and the Node.js >= 18 runtime to install; Linux official Node
  builds need glibc >= 2.28 and no special kernel features are used.
- `uniproxy apply` additionally needs systemd, xray, sing-box, nginx and root.
- Standalone binaries embed the Node.js runtime: macOS builds are ad-hoc signed,
  Linux builds follow the glibc baseline of the embedded Node.js. 32-bit Linux
  and Windows binaries are not built because Node.js no longer ships 32-bit
  runtimes for those targets.

## 0.3.0

Reference upgrade after comparing with [Marzban](https://github.com/Gozargah/Marzban)
and [Hiddify Manager](https://github.com/hiddify/Hiddify-Manager).

### Added

- **User registry** (`users` in `config.json`): one user spans several inbounds
  and both cores, with `expireAt`, `dataLimitBytes`, `usage`, `enabled`,
  `subToken` and `note`.
- Deterministic provisioning: users listed with `inbounds` are materialised into
  those inbounds; credentials derive from `server.secret` and stay stable across
  regenerations.
- Quota / expiry / disabled status; subscription endpoints return **403** with
  `subscription-userinfo` for inactive users.
- Subscription headers `subscription-userinfo`, `profile-web-page-url`,
  `support-url`.
- Routing profiles (`subscription.routing`): bypass LAN, direct domains/CIDRs
  and blocked domains for both sing-box route rules and Clash rules.
- Xray `fallbacks` support (multi-inbound on a single port, Marzban pattern).
- `users` command (table or `--json`); dashboard user table; doctor warnings
  for expired / over-quota / unbound users.
- 10 new tests (44 total).

### Changed

- Registry users share one subscription token across inbounds and cores; the
  subscription identity is the user name instead of name + credential.
- `init` now writes `server.secret`, `users` and `subscription.routing`.
- `subscription.publicBase` validation also covers `webPageUrl` and
  `supportUrl`.

## 0.2.0

Reference upgrade after comparing with [s-ui-x](https://github.com/deposist/s-ui-x).

### Added

- Per-client subscriptions in three formats: base64 link list, sing-box profile
  JSON, Clash/Mihomo YAML, also written to `out/sub/` by `generate`.
- Dashboard subscription endpoints `/sub/<token>`, `/sub/<token>/json`,
  `/sub/<token>/clash` with `no-store` and profile headers.
- `subscribe` command to list subscription URLs.
- `doctor` command: placeholders, certificate expiry, Reality key pairs,
  duplicate SNI / server_name, port conflicts, core binary probes.
- `apply` command: staged validation, timestamped backups, reload commands and
  automatic restore when a reload fails.
- Transports `httpupgrade` (Xray + sing-box) and `xhttp` (Xray).
- s-ui subscription server routing (default `127.0.0.1:2096`, path `/sub/`)
  plus port-planner accounting.
- `nginx.extraSites` for extra proxied hostnames.
- HTTP/2 style switch (`nginx.http2`: `listen` | `directive` | `off`).
- 34 unit tests (`node --test`).

### Changed

- Links are generated per client now; remarks are `<tag>-<client>`.
- `xtls-rprx-vision` is dropped (not emitted) unless VLESS + TCP + TLS/Reality.
- nginx: websocket upgrade map, HSTS/nosniff/no-referrer headers, gzip,
  TLS 1.2+ and session cache; panel proxying uses `$connection_upgrade`.
- Validation rejects unknown protocols/transports/security, duplicate tags and
  duplicate server names; credentials are checked per protocol.
- Config example no longer ships a real private key.

### Fixed

- sing-box trojan inbounds use per-user passwords only (no top-level password).
- H2 ALPN is set for h2 inbounds so clients negotiate correctly.
- s-ui subscription host is added to the 443 stream map and nginx vhosts.

## 0.1.0

- Initial control plane: Xray / sing-box / nginx generation, port planner,
  Reality links, read-only dashboard.