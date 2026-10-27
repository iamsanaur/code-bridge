#!/bin/sh
# Hosting platforms mount volumes owned by root; fix that, then drop to the unprivileged user.
set -e
if [ "$(id -u)" = "0" ]; then
  chown -R node:node "${DATA_DIR:-/data}" 2>/dev/null || true
  exec runuser -u node -- "$@"
fi
exec "$@"
