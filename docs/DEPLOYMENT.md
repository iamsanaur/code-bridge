# Deployment

## API

1. **Database**: PostgreSQL 16 with a dedicated role, TLS, private networking, encrypted backups (see retention notes in SECURITY.md).
2. **Secrets**: `CREDENTIAL_ENCRYPTION_KEY` from a secrets manager/KMS (32 random bytes, base64). Never commit it. Rotating it: bump `CREDENTIAL_KEY_VERSION` and have users re-enter cloud keys (automatic re-encryption is not implemented).
3. **Image**: `docker build -f infra/api.Dockerfile -t codebridge-api .` (runs as the `node` user; migrations apply at startup under an advisory lock).
4. **TLS**: terminate TLS at a reverse proxy/load balancer that supports WebSockets (idle timeout ≥ 60 s; the protocol pings every 15–30 s). Set `TRUST_PROXY=true` and `PUBLIC_URL=https://…`. The server refuses to start in production with an `http://` `PUBLIC_URL`.
5. **Single instance**: the relay holds sockets in memory. Run exactly one replica (or add sticky routing + a pub/sub layer before scaling out). Restarting the API disconnects agents and phones; both reconnect automatically and replay missed events from the Mac's buffer.
6. **Health checks**: `/healthz` (liveness), `/readyz` (database).
7. **Logs**: JSON to stdout, secrets redacted. Ship to your log system; don't enable `debug` in production.

Example:

```bash
docker run -d --name codebridge-api -p 127.0.0.1:8080:8080 \
  -e NODE_ENV=production -e PUBLIC_URL=https://codebridge.example.com \
  -e DATABASE_URL=postgres://codebridge:…@db:5432/codebridge?sslmode=require \
  -e CREDENTIAL_ENCRYPTION_KEY=… -e TRUST_PROXY=true \
  codebridge-api
```

> The Dockerfile and Compose file are provided but were not executed in the environment this code was written in (no Docker daemon). The compiled server (`node dist/src/server.js`) was run and verified.

## Mac agent

Distributed from source for now: `apps/mac-agent/scripts/install.sh` then `codebridge-agent service install`. Code-signed, notarised packages (or a Homebrew formula) are future work.

## Mobile app

Use EAS Build:

```bash
cd apps/mobile
# set the production API URL at build time
EXPO_PUBLIC_API_URL=https://codebridge.example.com eas build --platform ios
EXPO_PUBLIC_API_URL=https://codebridge.example.com eas build --platform android
```

`app.json` sets bundle ids (`dev.codebridge.app`), the camera usage string (QR scanning only), dark UI, and `allowBackup: false` on Android. No EAS project is configured in this repository.

## Anthropic

- Local coding agent: users store their own key on each Mac.
- Cloud sessions: Managed Agents is a beta API (`managed-agents-2026-04-01`, set by the SDK). The user's key must have Managed Agents access. CodeBridge creates one agent (`CodeBridge cloud agent`) and one cloud environment (`codebridge-cloud`) per user on first use and updates them in place when settings change. Sessions are archived when ended; agents and environments are left in place for reuse (archive them in the Anthropic Console if a user leaves).
