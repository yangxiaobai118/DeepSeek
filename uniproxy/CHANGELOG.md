# Changelog

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
