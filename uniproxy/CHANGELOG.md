# Changelog

## 0.3.1

### Added

- Per-platform release bundles, mirroring the asset matrix of Go-based panels:
  `linux-{386,amd64,arm64,armv5,armv6,armv7,s390x}` and
  `darwin-{amd64,arm64}` as `.tar.gz`, `windows-{amd64,386,arm64}` as
  `.zip`, each with a companion `.sha256` file and an aggregate
  `SHA256SUMS.txt`.
- `scripts/package.mjs` builds the matrix with sh / cmd / ps1 launchers and a
  `PLATFORM.txt` describing the target.
- Release workflow now builds the matrix on every push to `feature/uniproxy`
  (or manual dispatch) and updates the `uniproxy-v<version>` release.

### Notes

- uniproxy is pure JavaScript: every platform bundle carries the same code and
  runs on Node.js >= 18; the platform label selects the launcher.

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