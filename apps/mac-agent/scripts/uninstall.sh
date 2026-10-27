#!/usr/bin/env bash
# Removes the CodeBridge agent for the current user: revokes this Mac on the server
# (if reachable), stops the LaunchAgent, deletes Keychain items, config and the install.
set -uo pipefail
if command -v codebridge-agent >/dev/null; then
  codebridge-agent unpair || true
  codebridge-agent credentials clear || true
  [[ "$(uname -s)" == "Darwin" ]] && codebridge-agent service uninstall || true
fi
if [[ "$(uname -s)" == "Darwin" ]]; then
  rm -rf "$HOME/Library/Application Support/CodeBridge" "$HOME/Library/Logs/CodeBridge"
else
  rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/codebridge" "${XDG_CONFIG_HOME:-$HOME/.config}/codebridge"
fi
rm -f "${CODEBRIDGE_BIN_DIR:-$HOME/.local/bin}/codebridge-agent"
echo "CodeBridge agent removed."
