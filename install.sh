#!/bin/sh
# hitch installer for macOS, Linux and WSL.
#
#   curl -fsSL https://raw.githubusercontent.com/Nigmat-future/hitch/main/install.sh | sh
#
# Options (environment variables):
#   HITCH_VERSION=0.1.0   install a tagged release instead of main
#   HITCH_REF=<branch>    install another branch
#   HITCH_INSTALL_DIR     where the code goes   (default ~/.local/share/hitch)
#   HITCH_BIN_DIR         where the command goes (default ~/.local/bin)
#   HITCH_ARCHIVE         a local .tar.gz to install from instead of GitHub
#
# Uninstall:  curl -fsSL …/install.sh | sh -s -- --uninstall
#
# This script downloads one archive from github.com over HTTPS, unpacks it,
# and writes a two-line launcher. It needs Node.js 22+. It never touches
# your AI tool configs; hitch itself only does that when you ask.
set -eu

REPO="Nigmat-future/hitch"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
INSTALL_DIR="${HITCH_INSTALL_DIR:-$DATA_HOME/hitch}"
BIN_DIR="${HITCH_BIN_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
fail() { printf 'hitch install: %s\n' "$*" >&2; exit 1; }

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$BIN_DIR/hitch"
  rm -rf "$INSTALL_DIR"
  say "Removed $BIN_DIR/hitch and $INSTALL_DIR."
  say "Your Pi/OMP files and backups were not touched. ~/.hitch/state.json remains; delete it if you like."
  exit 0
fi

command -v node >/dev/null 2>&1 || fail "Node.js 22 or newer is required (https://nodejs.org)."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$NODE_MAJOR" -ge 22 ] 2>/dev/null || fail "Node.js 22 or newer is required; found $(node --version 2>/dev/null || echo none)."

if [ -n "${HITCH_VERSION:-}" ]; then
  REF_PATH="refs/tags/v${HITCH_VERSION#v}"
  LABEL="v${HITCH_VERSION#v}"
else
  REF_PATH="refs/heads/${HITCH_REF:-main}"
  LABEL="${HITCH_REF:-main}"
fi
URL="https://codeload.github.com/$REPO/tar.gz/$REF_PATH"

TMP=$(mktemp -d 2>/dev/null || mktemp -d -t hitch)
trap 'rm -rf "$TMP"' EXIT INT TERM

if [ -n "${HITCH_ARCHIVE:-}" ]; then
  [ -f "$HITCH_ARCHIVE" ] || fail "HITCH_ARCHIVE does not exist: $HITCH_ARCHIVE"
  cp "$HITCH_ARCHIVE" "$TMP/hitch.tar.gz"
  LABEL="local archive"
else
  say "Downloading hitch ($LABEL) from github.com/$REPO …"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https' --tlsv1.2 "$URL" -o "$TMP/hitch.tar.gz" || fail "download failed: $URL"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --https-only -O "$TMP/hitch.tar.gz" "$URL" || fail "download failed: $URL"
  else
    fail "curl or wget is required."
  fi
fi

mkdir -p "$TMP/src"
tar -xzf "$TMP/hitch.tar.gz" -C "$TMP/src" || fail "could not unpack the archive."
TOP=$(find "$TMP/src" -mindepth 1 -maxdepth 1 -type d | head -n 1)
[ -n "$TOP" ] && [ -f "$TOP/bin/hitch.js" ] || fail "archive does not look like hitch (bin/hitch.js missing)."

# Swap the new copy in only after it unpacked cleanly.
mkdir -p "$(dirname "$INSTALL_DIR")"
rm -rf "$INSTALL_DIR.new"
mkdir -p "$INSTALL_DIR.new"
for item in bin src package.json LICENSE README.md PRIVACY.md; do
  [ -e "$TOP/$item" ] && cp -R "$TOP/$item" "$INSTALL_DIR.new/"
done
rm -rf "$INSTALL_DIR"
mv "$INSTALL_DIR.new" "$INSTALL_DIR"

mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/hitch" <<EOF
#!/bin/sh
exec node "$INSTALL_DIR/bin/hitch.js" "\$@"
EOF
chmod 755 "$BIN_DIR/hitch"

VERSION=$(node -p "require('$INSTALL_DIR/package.json').version" 2>/dev/null || echo "?")
say "Installed hitch $VERSION to $INSTALL_DIR"
say "Command: $BIN_DIR/hitch"

case ":$PATH:" in
  *":$BIN_DIR:"*) say "Run: hitch" ;;
  *)
    say ""
    say "$BIN_DIR is not on your PATH. Add this line to ~/.bashrc, ~/.zshrc or your shell profile:"
    say "  export PATH=\"$BIN_DIR:\$PATH\""
    say "Pi and OMP need it too if you use \"!hitch key\" references."
    ;;
esac
