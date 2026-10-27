# Development

## Toolchain

- Node.js 22+, pnpm 10 (`corepack enable`), TypeScript 5.9
- PostgreSQL 16 (Docker Compose file provided)
- macOS for the real agent experience (Keychain, launchd). The agent also runs on Linux for development and CI: `node-pty` builds there, and `CODEBRIDGE_INSECURE_FILE_SECRETS=1` swaps the Keychain for a 0600 file (development only).
- Expo SDK 58 / React Native 0.88 for the app. Use Expo Go or a development build; QR scanning needs a camera, so use the manual code in the web preview.

## Install & build

```bash
pnpm install
pnpm build          # packages/protocol + packages/shared → dist/ (the apps import the built output)
```

Re-run `pnpm build` after changing anything in `packages/`.

## API

```bash
docker compose -f infra/docker-compose.yml up -d postgres
cp apps/api/.env.example apps/api/.env
# set CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -base64 32)
pnpm dev:api                    # tsx watch; applies migrations at startup
pnpm --filter @codebridge/api migrate   # or migrate explicitly
```

Environment variables (validated at startup by `apps/api/src/env.ts`; the server refuses to start with invalid config and never prints values):

| Variable                                                 | Default                 | Notes                                                                   |
| -------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------- |
| `DATABASE_URL`                                           | — (required)            | `postgres://…`                                                          |
| `PUBLIC_URL`                                             | `http://localhost:8080` | must be `https://` in production                                        |
| `HOST`, `PORT`                                           | `0.0.0.0`, `8080`       |                                                                         |
| `CREDENTIAL_ENCRYPTION_KEY`                              | —                       | 32 bytes base64; required in production when cloud sessions are enabled |
| `CREDENTIAL_KEY_VERSION`                                 | `1`                     | bump when rotating the key (old ciphertexts must be re-encrypted)       |
| `CORS_ORIGINS`                                           | empty (CORS off)        | comma-separated; only needed for the web preview                        |
| `TRUST_PROXY`                                            | `false`                 | `true` behind a TLS-terminating proxy                                   |
| `LOG_LEVEL`                                              | `info`                  |                                                                         |
| `ACCESS_TOKEN_TTL_SECONDS` / `REFRESH_TOKEN_TTL_SECONDS` | 900 / 2592000           |                                                                         |
| `PAIRING_TTL_SECONDS`                                    | 600                     |                                                                         |
| `COMMAND_ACK_TIMEOUT_MS`                                 | 10000                   | how long REST waits for the Mac                                         |
| `CLOUD_SESSIONS_ENABLED`                                 | `true`                  |                                                                         |
| `CLOUD_DEFAULT_MODEL`                                    | `claude-opus-5-5`       |                                                                         |
| `CLOUD_DEFAULT_BUDGET_CENTS`                             | 500                     | per-session hard cap                                                    |
| `CLOUD_MAX_CONCURRENT`                                   | 2                       | per user                                                                |
| `CLOUD_MAX_SESSION_MINUTES`                              | 120                     | sweeper ends older sessions                                             |
| `RATE_LIMIT_ENABLED`                                     | `true`                  | tests only                                                              |

## Mac agent

```bash
cd apps/mac-agent
pnpm exec tsx src/cli.ts pair --server http://localhost:8080 --name "My Mac"
pnpm exec tsx src/cli.ts workspace add ~/code/project
pnpm exec tsx src/cli.ts credentials set          # optional, coding agent
pnpm exec tsx src/cli.ts policy set allowCustomCommands true   # optional, high risk
pnpm exec tsx src/cli.ts run
```

Install for daily use (macOS, as your user):

```bash
./apps/mac-agent/scripts/install.sh      # builds & installs to ~/Library/Application Support/CodeBridge/agent
codebridge-agent pair --server https://codebridge.example.com
codebridge-agent workspace add ~/code/project
codebridge-agent service install         # LaunchAgent: starts at login, restarts on crash
codebridge-agent status
```

Uninstall: `./apps/mac-agent/scripts/uninstall.sh` (revokes the Mac, removes the LaunchAgent, Keychain items, config and logs).

Agent environment: `CODEBRIDGE_HOME` (config dir override), `CODEBRIDGE_LOG_LEVEL`, `CODEBRIDGE_ALLOW_INSECURE=1` (permit `http://` to non-local servers — don't), `CODEBRIDGE_INSECURE_FILE_SECRETS=1` (dev only).

Configuration lives in `~/Library/Application Support/CodeBridge/config.json` (0600): server URL, workspaces, policy (presets, switches, `envPassthrough`, PATH, limits) and coding-agent settings (`model`, `effort`, `maxTurnsPerPrompt`, `maxPromptMinutes`, `serverFallbacks`). Edit presets there; the agent picks up changes within 5 s.

## Mobile

```bash
cd apps/mobile
EXPO_PUBLIC_API_URL=http://192.168.1.20:8080 pnpm start     # LAN IP of the API for a physical phone
pnpm web                                                     # web preview (tokens kept in memory only)
pnpm test                                                    # jest-expo + React Native Testing Library
npx expo export --platform ios --platform android            # verify native JS bundles compile
```

## Tests

| Suite                                                                                         | Command                                                                                                        | Needs                                                                                          |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| protocol / shared unit tests                                                                  | `pnpm --filter @codebridge/protocol test` etc.                                                                 | —                                                                                              |
| API integration (real Postgres, real WebSockets) incl. end-to-end with the real agent runtime | `pnpm --filter @codebridge/api test`                                                                           | Postgres at `TEST_DATABASE_URL` (default `postgres://postgres@localhost:5432/codebridge_test`) |
| Mac agent (real PTYs, temp workspaces; mocked Messages API)                                   | `pnpm --filter @codebridge/mac-agent test`                                                                     | `git`, a POSIX shell                                                                           |
| Mobile (jest-expo)                                                                            | `pnpm --filter @codebridge/mobile test`                                                                        | —                                                                                              |
| Live Managed Agents test (**real, billable**)                                                 | `CODEBRIDGE_LIVE_ANTHROPIC_KEY=sk-ant-… pnpm --filter @codebridge/api exec vitest run test/cloud.live.test.ts` | Anthropic key with Managed Agents access                                                       |
| Browser end-to-end                                                                            | `node scripts/e2e-web.mjs` (`E2E_AGENT_USER=<user>` when running as root)                                      | Postgres, Playwright Chromium                                                                  |

Mocked vs real: test files that fake Anthropic say **MOCKED** in their header. Everything else runs against real Postgres, real sockets and real processes.
