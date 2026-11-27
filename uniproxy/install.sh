#!/bin/sh
# uniproxy one-line installer
#
#   sh -c "$(curl -fsSL https://raw.githubusercontent.com/yangxiaobai118/DeepSeek/feature/uniproxy/uniproxy/install.sh)"
#
# Detects the architecture, downloads the matching release asset (the
# self-contained binary when available, otherwise the Node bundle), installs
# the launchers, seeds the config, writes the systemd units and starts the
# panel. Nothing is interactive.
set -eu

REPO="${UNIPROXY_REPO:-yangxiaobai118/DeepSeek}"
PREFIX="${UNIPROXY_PREFIX:-/usr/local/uniproxy}"
BIN_DIR="${UNIPROXY_BIN_DIR:-/usr/local/bin}"
ETC_DIR="${UNIPROXY_ETC_DIR:-/etc/uniproxy}"
UNIT_DIR="${UNIPROXY_UNIT_DIR:-/etc/systemd/system}"
UI_PORT="${UNIPROXY_UI_PORT:-8788}"
SUB_PORT="${UNIPROXY_SUB_PORT:-8787}"
DRY_RUN="${UNIPROXY_DRY_RUN:-0}"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

fetch_to() {
  if have curl; then curl -fsSL "$1" -o "$2"
  elif have wget; then wget -qO "$2" "$1"
  else die 'need curl or wget'; fi
}

fetch_stdout() {
  if have curl; then curl -fsSL "$1"
  elif have wget; then wget -qO- "$1"
  else die 'need curl or wget'; fi
}

url_exists() {
  if have curl; then curl -fsIL "$1" >/dev/null 2>&1
  elif have wget; then wget --spider -q "$1" >/dev/null 2>&1
  else return 1; fi
}

arch=$(uname -m)
case "$arch" in
  x86_64|amd64) NODE_ARCH=linux-x64; TAR_ARCH=x86_64 ;;
  i386|i686) NODE_ARCH=linux-ia32; TAR_ARCH=i386 ;;
  aarch64|arm64) NODE_ARCH=linux-arm64; TAR_ARCH=arm64 ;;
  armv7l) NODE_ARCH=linux-armv7l; TAR_ARCH=armv7l ;;
  armv6l) NODE_ARCH=linux-armv6l; TAR_ARCH=armv6l ;;
  s390x) NODE_ARCH=linux-s390x; TAR_ARCH=s390x ;;
  ppc64le) NODE_ARCH=linux-ppc64le; TAR_ARCH=ppc64le ;;
  *) die "unsupported architecture: $arch" ;;
esac

if [ -n "${UNIPROXY_VERSION:-}" ]; then
  VERSION="$UNIPROXY_VERSION"
else
  tag=$(fetch_stdout "https://api.github.com/repos/$REPO/releases/latest" \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"uniproxy-v\([^"]*\)".*/\1/p' \
    | head -n 1) || tag=''
  if [ -z "$tag" ]; then
    if [ "$DRY_RUN" = "1" ]; then VERSION=unknown; else die 'cannot detect the latest release; set UNIPROXY_VERSION'; fi
  else
    VERSION="$tag"
  fi
fi

BASE="https://github.com/$REPO/releases/download/uniproxy-v$VERSION"
SEA_NAME="uniproxy-$VERSION-$NODE_ARCH"
TAR_NAME="uniproxy-$VERSION-linux-$TAR_ARCH.tar.gz"

MODE=sea
if url_exists "$BASE/$SEA_NAME"; then
  MODE=sea
  ASSET="$BASE/$SEA_NAME"
else
  MODE=tar
  ASSET="$BASE/$TAR_NAME"
fi

if [ "$DRY_RUN" = "1" ]; then
  say "arch:        $arch ($NODE_ARCH / $TAR_ARCH)"
  say "version:     $VERSION"
  say "mode:        $MODE"
  say "asset:       $ASSET"
  say "prefix:      $PREFIX"
  say "bin:         $BIN_DIR/uniproxy, $BIN_DIR/u-ui"
  say "config:      $ETC_DIR/config.json"
  say "units:       $UNIT_DIR/uniproxy-ui.service, uniproxy-sub.service"
  exit 0
fi

[ "$(id -u)" = "0" ] || die 'run as root (sudo)'

if [ "$MODE" = "tar" ] && ! have node; then
  die 'this build needs Node.js >= 18 (no self-contained binary for this platform)'
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

say "downloading $ASSET"
fetch_to "$ASSET" "$tmp/asset"

mkdir -p "$PREFIX" "$BIN_DIR" "$ETC_DIR" "$UNIT_DIR"

if [ "$MODE" = "sea" ]; then
  install -m 755 "$tmp/asset" "$PREFIX/uniproxy"
else
  tar -xzf "$tmp/asset" -C "$(dirname "$PREFIX")"
  [ -f "$PREFIX/src/index.js" ] || die "unexpected archive layout (expected $PREFIX/src/index.js)"
fi

if [ "$MODE" = "sea" ]; then
  printf '#!/bin/sh\nexec "%s/uniproxy" "$@"\n' "$PREFIX" > "$BIN_DIR/uniproxy"
  printf '#!/bin/sh\nexec "%s/uniproxy" menu "$@"\n' "$PREFIX" > "$BIN_DIR/u-ui"
else
  printf '#!/bin/sh\nexec "%s" "%s/src/index.js" "$@"\n' "${UNIPROXY_NODE:-node}" "$PREFIX" > "$BIN_DIR/uniproxy"
  printf '#!/bin/sh\nexec "%s" "%s/src/u-ui.js" "$@"\n' "${UNIPROXY_NODE:-node}" "$PREFIX" > "$BIN_DIR/u-ui"
fi
chmod 755 "$BIN_DIR/uniproxy" "$BIN_DIR/u-ui"

if [ ! -f "$ETC_DIR/config.json" ]; then
  "$BIN_DIR/uniproxy" init -c "$ETC_DIR/config.json" || true
  say "generated $ETC_DIR/config.json"
fi

write_unit() {
  _name="$1"; _desc="$2"; _args="$3"
  cat > "$UNIT_DIR/$_name" <<EOF
[Unit]
Description=$_desc
After=network.target

[Service]
Type=simple
WorkingDirectory=$PREFIX
ExecStart=$BIN_DIR/uniproxy $_args
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
}

write_unit uniproxy-ui.service 'uniproxy u-ui panel' "ui -c $ETC_DIR/config.json -p $UI_PORT"
write_unit uniproxy-sub.service 'uniproxy subscription server' "serve -c $ETC_DIR/config.json -p $SUB_PORT"

if have systemctl; then
  systemctl daemon-reload || true
  systemctl enable uniproxy-ui.service >/dev/null 2>&1 || true
  systemctl restart uniproxy-ui.service || say 'warning: could not start uniproxy-ui'
fi

say ''
say "installed uniproxy $VERSION ($MODE)"
say "  panel:  http://127.0.0.1:$UI_PORT  (tunnel: ssh -L $UI_PORT:127.0.0.1:$UI_PORT root@this-host)"
say "  config: $ETC_DIR/config.json  (edit it, then: u-ui -> 16 validate / 18 apply)"
say "  menu:   u-ui"
