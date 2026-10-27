# CodeBridge

Control coding sessions on **your own Mac** from your iPhone or Android phone, from anywhere, and optionally run separate **CodeBridge-managed cloud sessions** on Anthropic Managed Agents.

> **The Mac session executes on your Mac. The cloud session executes in an Anthropic-hosted sandbox.** CodeBridge never moves your local projects to a cloud machine, and every session in the app is labelled **Local Mac** or **Managed cloud**.

```
┌──────────────┐   HTTPS + WSS (auth'd)   ┌─────────────────────┐   WSS, outbound from the Mac   ┌──────────────────────┐
│ Native apps  │ ───────────────────────▶ │  CodeBridge API     │ ◀──────────────────────────── │  Mac agent (your user)│
│ SwiftUI iOS, │ ◀─────────────────────── │  relay + Postgres   │ ──────────────────────────────▶│  PTY · coding agent  │
│ Compose Andr.│   live events, approvals │  (Fastify)          │   commands (policy-checked     │  workspace allowlist │
└──────────────┘                          └──────────┬──────────┘    again on the Mac)           └──────────────────────┘
                                                     │ Managed Agents API (user's key, encrypted at rest)
                                                     ▼
                                          ┌─────────────────────┐
                                          │ Anthropic cloud     │  separate, isolated sandbox — no access to your Mac
                                          └─────────────────────┘
```

## What works today

| Area                                                                                                                                                                  | Status                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts: register, login, rotating refresh tokens with reuse detection, logout, account deletion                                                                     | ✅ implemented & tested                                                                                                                      |
| Pairing: short-lived, single-use code/QR (RFC 8628-style), local confirmation on the Mac, revocation, credential rotation                                             | ✅ implemented & tested                                                                                                                      |
| Relay: outbound authenticated agent WebSocket, sequenced events, replay after reconnects, de-duplication, heartbeats, rate & size limits                              | ✅ implemented & tested                                                                                                                      |
| Local sessions: approved workspaces, preset commands in a PTY, terminal input, interrupt/stop, exit codes, "lost" detection after restarts                            | ✅ implemented & tested end-to-end                                                                                                           |
| Local policy: custom commands and interactive shells off by default; deny-list; risky-command confirmation; env sanitisation; symlink-safe path confinement           | ✅ implemented & tested                                                                                                                      |
| Coding agent (Anthropic Messages API, your key in the Mac Keychain): streaming, bounded tool loop, approvals for edits/commands, cancellation, usage & cost estimates | ✅ implemented; tested against a **mocked** API (no live key was available)                                                                  |
| Claude Code CLI provider (headless `claude -p`, uses the CLI's own login)                                                                                             | ✅ implemented; output parsing tested with mocked CLI output                                                                                 |
| Managed cloud sessions (Anthropic Managed Agents beta): create, stream, approve tools, prompt, interrupt, end (archive), budgets, quotas, cleanup                     | ✅ implemented; tested with a **mocked** provider; opt-in live test included but **not run** (no key)                                        |
| **iOS app** (SwiftUI, iOS 26, Liquid Glass): all screens, glass tab bar with connection accessory, floating glass terminal key bar & composer, VisionKit QR pairing   | ✅ `CodeBridgeKit` unit tests pass and the app builds for the iOS Simulator in CI (Xcode on macOS 26); **not yet run on a device/simulator** |
| **Android app** (Kotlin, Jetpack Compose, Material 3): all screens, Keystore-encrypted tokens, Google code scanner pairing                                            | ✅ Kotlin core: 22 tests incl. a contract test against the real API (local + CI); `:app` builds in CI; **not yet run on a device/emulator**  |
| Docker Compose / API Dockerfile                                                                                                                                       | ✍️ written, **not run** here (no Docker daemon in the build environment)                                                                     |

See [docs/PLAN.md](docs/PLAN.md) for milestones and remaining work, and [docs/SECURITY.md](docs/SECURITY.md) for the threat model.

## Quick start (local development)

Prerequisites: Node.js 22+, pnpm 10 (`corepack enable`), PostgreSQL 16 (or Docker).

```bash
pnpm install
pnpm build                                   # builds packages/protocol and packages/shared

# 1. Database + API
docker compose -f infra/docker-compose.yml up -d postgres      # or use your own Postgres
cp apps/api/.env.example apps/api/.env                         # set DATABASE_URL and CREDENTIAL_ENCRYPTION_KEY
pnpm dev:api                                                   # http://localhost:8080 (runs migrations on start)

# 2. Mac agent (on your Mac, as your normal user — never root)
pnpm --filter codebridge-agent exec tsx src/cli.ts pair --server http://localhost:8080
pnpm --filter codebridge-agent exec tsx src/cli.ts workspace add ~/code/my-project
pnpm dev:agent                                                 # = codebridge-agent run

# 3. Phone apps
open apps/ios/CodeBridge.xcodeproj          # Xcode 26+, run on an iOS 26 device/simulator (set CODEBRIDGE_API_URL)
cd apps/android && ./gradlew :app:installDebug   # Android Studio / SDK 36; emulator reaches the API at 10.0.2.2
```

On the phone: create an account → **Pair a Mac** → scan the QR code (or type the code) → approve → confirm on the Mac → open the Mac → pick a workspace → **New session** → choose a preset → watch the output live.

For a permanent install on a Mac or Windows PC use `npm install -g codebridge-agent` and `codebridge-agent service install` (LaunchAgent on macOS, scheduled task on Windows). See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Repository layout

```
apps/
  api/          Fastify API + WebSocket relay + Postgres migrations + cloud provider adapter
  mac-agent/    macOS/Windows agent & CLI, published as `codebridge-agent` (pairing, PTY sessions, coding agent, Claude Code provider, launchd / Task Scheduler)
  ios/          native iOS app: SwiftUI + Liquid Glass (CodeBridge.xcodeproj) and the CodeBridgeKit Swift package
  android/      native Android app: Jetpack Compose + Material 3 (:app) and a pure-Kotlin core (:core)
packages/
  protocol/     zod schemas for every message crossing a trust boundary, shared DTOs and limits
  shared/       secret redaction, terminal model, backoff, pricing estimates
docs/           ARCHITECTURE, SECURITY, API, DEVELOPMENT, DEPLOYMENT, PLAN
infra/          docker-compose.yml, api.Dockerfile
```

## Tests

```bash
pnpm test        # protocol, shared, api (needs Postgres: TEST_DATABASE_URL), mac-agent
pnpm test:android                    # Kotlin core (JVM); add CODEBRIDGE_IT_API_URL=http://localhost:8080 for the contract test
swift test --package-path apps/ios/CodeBridgeKit   # on macOS
pnpm lint && pnpm typecheck && pnpm format:check
```

Tests marked **mocked** in their file headers use fakes for Anthropic's APIs; `apps/api/test/cloud.live.test.ts` is the only test that calls Anthropic for real and runs only when `CODEBRIDGE_LIVE_ANTHROPIC_KEY` is set.

## Billing

- **Local coding agent**: calls the Anthropic Messages API with the key stored in your Mac's Keychain; Anthropic bills that key. CodeBridge shows token usage and an estimate at list price.
- **Claude Code sessions**: use whatever the `claude` CLI is logged in with on your Mac. CodeBridge does not touch those credentials.
- **Cloud sessions**: Anthropic Managed Agents, billed to the key you store for cloud use (model tokens at list price plus session runtime, $0.08 per active hour at the time of writing). Each session has a hard dollar budget enforced by Anthropic.
- **CodeBridge server**: you host it; its costs are your infrastructure costs.

## License

[MIT](LICENSE)
