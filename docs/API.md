# API reference

Base URL: `PUBLIC_URL` (HTTPS in production). JSON bodies. Errors: `{ "code": string, "message": string }` with an HTTP status. Authenticated endpoints take `Authorization: Bearer <accessToken>`; device endpoints take `Authorization: Bearer <deviceSecret>`.

Control operations accept `Idempotency-Key: <uuid>`. Repeating a request with the same key returns the stored result and never re-executes. A key whose earlier attempt failed with a final error (e.g. `requires_confirmation`) keeps returning that error: send a **new** key for the follow-up request.

## Auth

| Method & path            | Body                      | Response                                                  |
| ------------------------ | ------------------------- | --------------------------------------------------------- |
| `POST /v1/auth/register` | `{email, password (≥12)}` | `201 {user, tokens}` · `409 email_taken`                  |
| `POST /v1/auth/login`    | `{email, password}`       | `{user, tokens}` · `401`                                  |
| `POST /v1/auth/refresh`  | `{refreshToken}`          | `{tokens}` (rotated) · `401` (re-use revokes the session) |
| `POST /v1/auth/logout`   | —                         | `{ok}`                                                    |
| `GET /v1/me`             | —                         | `{id, email, createdAt}`                                  |
| `DELETE /v1/me`          | `{password}`              | `{ok}`                                                    |

`tokens = {accessToken, refreshToken, accessExpiresAt, refreshExpiresAt}`.

## Pairing (device authorization)

| Method & path                            | Auth           | Body                                 | Response                                                                                      |
| ---------------------------------------- | -------------- | ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `POST /v1/pairing/start`                 | —              | `{deviceName, hostname?, platform?}` | `201 {pairingId, userCode, pollSecret, expiresAt, pollIntervalSeconds, qrPayload}`            |
| `POST /v1/pairing/claim`                 | user           | `{code}`                             | `{pairingId, deviceName, hostname, platform, requestedAt, expiresAt}` · `404` invalid/expired |
| `POST /v1/pairing/:id/approve` · `/deny` | user (claimer) | —                                    | `{ok}`                                                                                        |
| `POST /v1/pairing/poll`                  | —              | `{pairingId, pollSecret}`            | `{status: pending                                                                             | denied | expired | completed}`or once:`{status:'approved', deviceId, deviceSecret, accountEmail}` |

## Devices

| Method & path                 | Auth   | Notes                                                                     |
| ----------------------------- | ------ | ------------------------------------------------------------------------- |
| `GET /v1/devices`             | user   | `{devices: DeviceDto[]}` with `online`, capabilities, workspaces, presets |
| `GET /v1/devices/:id`         | user   | `DeviceDto`                                                               |
| `PATCH /v1/devices/:id`       | user   | `{name}`                                                                  |
| `DELETE /v1/devices/:id`      | user   | revoke: credential invalid, socket closed, sessions `killed`              |
| `GET /v1/device/self`         | device | `{deviceId, name, accountEmail, secretRotatedAt}`                         |
| `POST /v1/device/rotate`      | device | `{deviceSecret}`; old secret valid 10 more minutes                        |
| `POST /v1/device/self/revoke` | device | unpair from the Mac                                                       |

## Sessions

| Method & path                                                        | Notes                                              |
| -------------------------------------------------------------------- | -------------------------------------------------- |
| `GET /v1/sessions?kind=local                                         | cloud&active=true                                  | false&deviceId=&limit=`              | `{sessions: SessionDto[]}` |
| `GET /v1/sessions/:id`                                               | `SessionDto`                                       |
| `POST /v1/devices/:deviceId/sessions` (Idempotency-Key **required**) | body `{workspaceId, mode: command                  | shell                                | agent                      | claude_code, presetId?, argv?, confirmedRisk?, prompt?, model?, cols?, rows?}`→`201 SessionDto`. Errors from the Mac: `403 policy_denied`, `409 requires_confirmation`, `404 not_found`, `422 anthropic_key_missing | unavailable | …`, `409 device_offline`, `503 timeout` |
| `POST /v1/sessions/:id/signal`                                       | `{signal: interrupt                                | terminate}` (cloud: interrupt / end) |
| `POST /v1/sessions/:id/prompt`                                       | `{text}` for agent, Claude Code and cloud sessions |
| `POST /v1/sessions/:id/approvals/:approvalId`                        | `{decision: approve                                | reject}`                             |
| `GET /v1/devices/:deviceId/workspaces/:workspaceId/git/status`       | `{branch, ahead, behind, files[], truncated}`      |
| `GET /v1/devices/:deviceId/workspaces/:workspaceId/git/diff?path=`   | `{diff, truncated}`                                |
| `GET /v1/usage`                                                      | 30-day token & estimated-cost totals by kind       |

## Credentials & cloud

| Method & path                                        | Notes                                                                                  |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /v1/credentials/anthropic`                      | `{configured, hint, createdAt, storageAvailable}` (never the key)                      |
| `PUT /v1/credentials/anthropic`                      | `{apiKey}` — stored encrypted, for cloud sessions only                                 |
| `DELETE /v1/credentials/anthropic`                   |                                                                                        |
| `GET /v1/cloud/config`                               | model, networking, allowed hosts, budget, quota, resource ids, billing & sandbox notes |
| `PUT /v1/cloud/config`                               | `{model?, networking?: limited                                                         | unrestricted, allowedHosts?, budgetCents? (10–10000)}` — applied at Anthropic immediately when a key exists |
| `POST /v1/cloud/sessions` (Idempotency-Key required) | `{prompt, title?}` → `201 SessionDto` · `409 credential_missing                        | quota_exceeded`·`400 invalid_api_key`                                                                       |
| `POST /v1/cloud/sessions/:id/end`                    | interrupt + archive at Anthropic                                                       |

## WebSockets

### Phone: `/v1/client/ws`

Client → server: `auth {token}` (first, within 5 s) · `subscribe {sessionId, afterSeq}` · `unsubscribe {sessionId}` · `command {commandId, command: session.input|session.resize|session.signal}` · `ping {ts}`.

Server → client: `auth.ok` · `event {sessionId, seq, ts, event}` · `replay.gap {sessionId, resumeFromSeq}` · `command.ack {commandId, ok, error?}` · `device.status {deviceId, online, lastSeenAt}` · `session.status {sessionId, status, exitCode}` · `error {code, message}` · `pong`.

Close codes: `4401` unauthorized/signed out/revoked, `4409` replaced by newer connection, `4429` rate limited, `1009` frame too large.

### Mac agent: `/v1/agent/ws`

Agent → server: `agent.hello` (capabilities, workspaces, presets, live-session snapshot) · `agent.event` · `agent.ack {commandId, ok, error?, result?}` · `agent.ping`.

Server → agent: `server.hello {deviceId, serverTime}` · `server.command {commandId, issuedAt, command}` · `server.pong` · `server.revoked`.

### Session events (`event.kind`)

`status`, `output`, `user.prompt`, `agent.text`, `agent.turn_end`, `agent.tool_call`, `agent.tool_result`, `approval.request`, `approval.resolved`, `usage`, `error`. Exact shapes: `packages/protocol/src/index.ts`.

## Health

`GET /healthz` (process up) · `GET /readyz` (database reachable).
