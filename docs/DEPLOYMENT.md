# Deployment

## Personal relays (recommended)

Each person runs their own relay, so there is nothing for you to keep up. See
[apps/api/README.md](../apps/api/README.md): `npx codebridge-relay start --tunnel cloudflare` or
`npx codebridge-relay fly`. The `Relay image` workflow publishes `ghcr.io/<owner>/codebridge-relay` from `main`
(make the package public once: GitHub → Packages → codebridge-relay → Package settings). Releasing the relay is
the same as releasing the agent: bump `version` in `apps/api/package.json`, `npm publish` from `apps/api`.

## Shared relay (accounts)

What follows is for a single shared relay with email accounts (`RELAY_MODE=multi`).

## API

1. **Database**: PostgreSQL 16 with a dedicated role, TLS, private networking, encrypted backups (see retention notes in SECURITY.md).
2. **Secrets**: `CREDENTIAL_ENCRYPTION_KEY` from a secrets manager/KMS (32 random bytes, base64). Never commit it. Rotating it: bump `CREDENTIAL_KEY_VERSION` and have users re-enter cloud keys (automatic re-encryption is not implemented).
3. **Image**: `docker build -f infra/relay.Dockerfile -t codebridge-relay .`, then run it with `node dist/relay.js serve` and `RELAY_MODE=multi` (runs as the `node` user; migrations apply at startup under an advisory lock).
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

## Agent (macOS and Windows)

Published to npm as [`codebridge-agent`](https://www.npmjs.com/package/codebridge-agent) (Node 22+):

```bash
npm install -g codebridge-agent
codebridge-agent pair --server https://codebridge.example.com
codebridge-agent workspace add <dir>
codebridge-agent service install     # LaunchAgent (macOS) or per-user scheduled task (Windows)
```

The package is a single bundled file (`apps/mac-agent/scripts/bundle.mjs`) with the private workspace packages
inlined. Release checklist:

1. Bump `version` in `apps/mac-agent/package.json` **and** `AGENT_VERSION` in `src/version.ts`.
2. `pnpm --filter codebridge-agent test` on macOS and Windows (CI runs both).
3. `npm pack` in `apps/mac-agent`, install the tarball into an empty directory and run `codebridge-agent status`.
4. `npm publish` (the package is public; `prepack` builds the bundle).

Building from source on macOS: `apps/mac-agent/scripts/install.sh`. Code-signed, notarised packages, an MSI and a
Homebrew formula are future work.

## Phone apps

- **iOS**: archive in Xcode 26 with `CODEBRIDGE_API_URL=https://…` for Release, set your team for signing, and ship via TestFlight / App Store. Bundle id `com.e404.codebridge`.
- **Android**: `./gradlew :app:bundleRelease -Pcodebridge.apiUrl=https://…` (the build refuses non-HTTPS URLs), sign with your upload key, ship via Play. Application id `com.e404.codebridge`.

## Anthropic

- Local coding agent: users store their own key on each Mac.
- Cloud sessions: Managed Agents is a beta API (`managed-agents-2026-04-01`, set by the SDK). The user's key must have Managed Agents access. CodeBridge creates one agent (`CodeBridge cloud agent`) and one cloud environment (`codebridge-cloud`) per user on first use and updates them in place when settings change. Sessions are archived when ended; agents and environments are left in place for reuse (archive them in the Anthropic Console if a user leaves).
