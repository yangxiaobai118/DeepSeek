# uniproxy

Control plane for **Xray + sing-box + nginx** on one host: one JSON config, port planning, native configs, :443 SNI multiplexing, subscriptions and the **u-ui** management panel.

This is the package README. The main project README, feature list and platform matrix live in the repository root: [README.md](https://github.com/yangxiaobai118/DeepSeek/tree/feature/uniproxy#readme).

## Install

### One-line (Linux, systemd, root)

```bash
bash <(curl -Ls https://raw.githubusercontent.com/yangxiaobai118/DeepSeek/feature/uniproxy/uniproxy/install.sh)
```

Pin a version or preview the plan:

```bash
bash <(curl -Ls https://raw.githubusercontent.com/yangxiaobai118/DeepSeek/feature/uniproxy/uniproxy/install.sh) 0.4.6
UNIPROXY_DRY_RUN=1 bash <(curl -Ls https://raw.githubusercontent.com/yangxiaobai118/DeepSeek/feature/uniproxy/uniproxy/install.sh)
```

### npm / tarball (Node.js >= 18)

```bash
npm install -g https://github.com/yangxiaobai118/DeepSeek/releases/download/uniproxy-v0.4.6/uniproxy-0.4.6.tgz
uniproxy init -c config.json
uniproxy setup -c config.json --yes
uniproxy validate -c config.json
```

Self-contained binaries for linux-x64, linux-arm64, linux-ppc64le, linux-s390x, linux-musl-x64, win-x64, win-arm64, darwin-x64 and darwin-arm64 are on the [releases page](https://github.com/yangxiaobai118/DeepSeek/releases).

## Usage

```bash
u-ui                                              # terminal menu (3x-ui style)
uniproxy ui      -c config.json [-p 8788]         # u-ui web panel
uniproxy validate -c config.json                  # schema + port checks
uniproxy doctor  -c config.json                   # certificates/keys/cores
uniproxy generate -c config.json -o out           # write the three configs
uniproxy apply   -c config.json --yes             # validate, back up, install, reload
uniproxy serve   -c config.json [-p 8787]         # subscription server
```

After the one-line install:

| Item | Value |
|------|-------|
| Menu | `u-ui` |
| Panel | `http://127.0.0.1:8788` (SSH tunnel recommended) |
| Config | `/etc/uniproxy/config.json` |
| Services | `uniproxy-ui.service`, `uniproxy-sub.service` |

## Documentation

- [Install guide (English)](https://github.com/yangxiaobai118/DeepSeek/blob/feature/uniproxy/uniproxy/docs/INSTALL.md)
- [安装与部署手册（中文）](https://github.com/yangxiaobai118/DeepSeek/blob/feature/uniproxy/uniproxy/docs/INSTALL.zh-CN.md)
- [u-ui design and API](https://github.com/yangxiaobai118/DeepSeek/blob/feature/uniproxy/uniproxy/docs/U-UI.md)
- [Changelog](https://github.com/yangxiaobai118/DeepSeek/blob/feature/uniproxy/uniproxy/CHANGELOG.md)

## License

MIT. See [LICENSE](LICENSE). Disclaimer in [DISCLAIMER.md](DISCLAIMER.md).
