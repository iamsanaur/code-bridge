#!/usr/bin/env bash
# Installs the CodeBridge agent for the current (non-root) macOS user from this checkout.
#   ./apps/mac-agent/scripts/install.sh
# Result:
#   ~/Library/Application Support/CodeBridge/agent   self-contained agent install
#   ~/.local/bin/codebridge-agent                    command-line entry point
set -euo pipefail

if [[ "$(id -u)" == "0" ]]; then
  echo "Do not run the installer as root (or with sudo). CodeBridge runs as your user." >&2
  exit 1
fi
if [[ "$(uname -s)" != "Darwin" && "${CODEBRIDGE_FORCE_INSTALL:-}" != "1" ]]; then
  echo "This installer targets macOS. Set CODEBRIDGE_FORCE_INSTALL=1 to install on $(uname -s) for development." >&2
  exit 1
fi
command -v node >/dev/null || { echo "Node.js 22+ is required (brew install node)." >&2; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || { echo "Node.js 22+ is required." >&2; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm is required (corepack enable)." >&2; exit 1; }

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
if [[ "$(uname -s)" == "Darwin" ]]; then
  DEST="${CODEBRIDGE_AGENT_DIR:-$HOME/Library/Application Support/CodeBridge/agent}"
else
  DEST="${CODEBRIDGE_AGENT_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/codebridge/agent}"
fi
BIN_DIR="${CODEBRIDGE_BIN_DIR:-$HOME/.local/bin}"

echo "Building from $REPO"
cd "$REPO"
pnpm install --frozen-lockfile --filter @codebridge/mac-agent...
pnpm --filter @codebridge/protocol --filter @codebridge/shared build
pnpm --filter @codebridge/mac-agent build

echo "Installing to $DEST"
rm -rf "$DEST"
pnpm --filter @codebridge/mac-agent deploy --prod --legacy "$DEST"
chmod 700 "$(dirname "$DEST")"

mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/codebridge-agent" <<WRAP
#!/usr/bin/env bash
exec "$(command -v node)" "$DEST/dist/src/cli.js" "\$@"
WRAP
chmod 755 "$BIN_DIR/codebridge-agent"

echo
echo "Installed. Next steps:"
echo "  codebridge-agent pair --server https://your-codebridge-server"
echo "  codebridge-agent workspace add ~/code/my-project"
echo "  codebridge-agent credentials set        # optional: Anthropic API key for the coding agent"
echo "  codebridge-agent service install        # start at login (LaunchAgent)"
[[ ":$PATH:" == *":$BIN_DIR:"* ]] || echo "Add $BIN_DIR to your PATH."
