# Architecture

## Components

| Component                        | Runs where                                        | Responsibilities                                                                                                                                                                              |
| -------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mobile app** (`apps/mobile`)   | iOS / Android (Expo); web preview for development | Sign-in, pairing, device & session management, live terminal, agent chat, approvals, cloud configuration, usage                                                                               |
| **API / relay** (`apps/api`)     | Your server (single instance)                     | Accounts and tokens, pairing, device registry, session metadata, idempotent command dispatch, event relay with replay buffer, audit log, encrypted cloud credentials, cloud session lifecycle |
| **Mac agent** (`apps/mac-agent`) | Each Mac, as the logged-in user (LaunchAgent)     | Outbound connection to the relay, local policy enforcement, PTY sessions, the Anthropic coding agent, Claude Code CLI sessions, git status/diff, Keychain secrets                             |
| **Managed Agents** (Anthropic)   | Anthropic cloud                                   | Hosts CodeBridge-managed cloud sessions in isolated containers                                                                                                                                |

`packages/protocol` defines every message as a zod schema; all three components validate inbound frames against it and drop anything invalid.

## Connections

- **Mac → relay**: `wss://<server>/v1/agent/ws`, authenticated _before the upgrade_ with `Authorization: Bearer cbd_…` (device credential). The device id is derived from the credential, never from client input. No inbound ports are opened on the Mac.
- **Phone → relay**: `wss://<server>/v1/client/ws`. First frame must be `{type:"auth", token}` within 5 s (tokens never go in URLs). The socket re-checks every 60 s that the sign-in session is still valid.
- **Phone → API (REST)**: control operations (start session, stop, prompt, approvals, git, cloud) with `Idempotency-Key` headers.
- **API → Anthropic**: Managed Agents API (beta header `managed-agents-2026-04-01`, set by the official SDK) for cloud sessions only.
- **Mac → Anthropic**: Messages API from the coding agent, with the key from the Mac's Keychain.

## Session model

```
kind=local  mode ∈ {command, shell, agent, claude_code}   device_id set, executes on the Mac
kind=cloud  mode = managed_agent                          no device, executes at Anthropic
```

Status: `starting → running ⇄ waiting/idle → completed | failed | killed | lost`. `lost` means the agent restarted (or the Mac rebooted) and the process no longer exists; CodeBridge never pretends a process survived a restart.

## Commands and events

1. The phone calls `POST /v1/devices/:id/sessions` with an `Idempotency-Key`. The API checks ownership, derives a deterministic session id from (user, key), writes a `commands` row (unique per key), and forwards `server.command` to the Mac.
2. The Mac re-validates the command against _its own_ policy (workspace allowlist, presets, switches, deny lists, replay window), de-duplicates the command id, executes, and replies with `agent.ack`.
3. Output and state changes flow back as `agent.event` frames with a per-session, gap-free `seq`. The relay checks the session belongs to the sending device, persists status/usage metadata (never terminal output), keeps a bounded in-memory replay buffer, and fans out to the owner's subscribed sockets.
4. High-frequency terminal input/resize/interrupt go over the phone's WebSocket with their own command ids (de-duplicated at the relay and on the Mac).

### Ordering, duplicates and reconnection

- Every session event has a monotonically increasing `seq` assigned on the Mac (or by the cloud watcher).
- **Phone reconnects**: the app re-subscribes with `afterSeq = last applied seq`. The relay replays from its buffer, or asks the Mac to replay from its ring (5,000 events / 4 MB per session). If events are gone everywhere, the client receives `replay.gap` and shows "earlier output is no longer available".
- **Mac reconnects**: the agent sends `agent.hello` with a snapshot of live sessions (the relay marks missing ones `lost`), then re-sends events after the last frame it knows reached the socket, with a 50-event overlap. Receivers de-duplicate by `seq`, so delivery is at-least-once with exactly-once application.
- The app applies events strictly in order, buffering early arrivals and re-requesting gaps.

## Providers

| Provider                                                       | Where     | Notes                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AgentSession` (AnthropicMessagesProvider)                     | Mac agent | Official SDK, `client.beta.messages.stream`, streaming text, client-side tools with `eager_input_streaming` + zod validation, adaptive thinking (default for `claude-opus-5-5`), `output_config.effort`, server-side refusal fallbacks (`server-side-fallback-2026-07-01`, `fallbacks: "default"`), prompt caching. Bounded by turns per prompt and wall-clock per prompt; cancellable. |
| `ClaudeCodeSession` (LocalClaudeCodeProvider)                  | Mac agent | Spawns the installed `claude` CLI in headless mode (`-p --output-format stream-json`), resumes with `--resume`. Uses the CLI's own login; no credentials are read or forwarded.                                                                                                                                                                                                         |
| `AnthropicManagedAgentsProvider` (ManagedCloudSessionProvider) | API       | Creates one agent + one cloud environment per user (stored ids, updated in place), then sessions with a hard `budget`. Streams events (stream-first, then history, de-duplicated by event id), maps them to CodeBridge events, handles `requires_action` tool confirmations, interrupt and archive.                                                                                     |

The mobile app only sees CodeBridge DTOs and events, so providers can change without app changes.

## Scaling notes

The relay keeps agent and phone sockets in process memory, so it runs as **one instance**. Horizontal scaling needs a routing layer (e.g. Redis pub/sub keyed by device id, or sticky routing by device), which is deliberately not built yet. Postgres holds all durable state.
