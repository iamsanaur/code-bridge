# Security

CodeBridge gives a phone the ability to run programs on a computer. It is designed as a high-risk capability: conservative defaults, decisions enforced on the Mac, and every boundary validated.

## Threat model

| Asset                          | Threats                                                                                                      | Mitigations                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code execution on the Mac      | Stolen phone session, stolen device credential, malicious relay operator, model misbehaviour, path traversal | Policy enforced **on the Mac** (not the server): workspace allowlist added only via the local CLI; presets only by default; custom commands and interactive shells off until enabled locally; deny-list (`sudo`, `security`, `osascript`, `launchctl`, …); risky commands need explicit confirmation; executables resolved by name on absolute PATH entries; no shell interpretation; sanitised child environment; agent refuses to run as root                         |
| Files outside approved folders | `../`, absolute paths, symlink escapes, TOCTOU                                                               | `resolveInWorkspace` canonicalises the deepest existing ancestor with `realpath` and rejects anything outside the workspace root; file I/O uses `O_NOFOLLOW`; search never follows symlinks                                                                                                                                                                                                                                                                             |
| Anthropic API keys             | Logs, relay traffic, child processes, database leaks                                                         | Local key lives only in the Mac's Keychain and never leaves the agent process; never sent through the relay; not inherited by child processes. Cloud key is sent once over TLS, stored AES-256-GCM encrypted (key from `CREDENTIAL_ENCRYPTION_KEY`, user id as AAD), never returned, decrypted only in memory                                                                                                                                                           |
| Account sessions               | Token theft, replay                                                                                          | Opaque 256-bit tokens, stored as SHA-256 hashes; 15-minute access tokens checked against the DB on every request; refresh tokens rotate on every use and re-use revokes the session (OAuth 2.0 Security BCP); phone tokens kept in iOS Keychain / Android Keystore (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`)                                                                                                                                                                   |
| Device credentials             | Theft, leaked pairing code                                                                                   | Pairing modelled on RFC 8628: 8-char code (~40 bits) valid 10 minutes, single-use, rate-limited, claim requires a signed-in user, credential only collectable with the agent's private poll secret; Mac owner confirms the account email locally before keeping the credential; credentials hashed at rest, rotate every 7 days with a 10-minute grace window; revocation closes the socket and stops all sessions immediately; agent wipes its credential when revoked |
| Relay integrity                | Spoofed device ids, cross-user access, event injection                                                       | Device identity derived from the credential; every REST/WS operation checks ownership; events accepted only for sessions owned by the sending device; clients can only subscribe to their own sessions; phone WS ops limited to input/resize/signal                                                                                                                                                                                                                     |
| Availability                   | Floods, oversized frames                                                                                     | REST rate limits (global + stricter auth/pairing limits), 256 KB frame and body limits, per-socket token buckets (close code 4429), heartbeat timeouts, bounded buffers everywhere                                                                                                                                                                                                                                                                                      |
| Replay / duplicate execution   | Retries, reconnects                                                                                          | Idempotency keys on REST control ops (unique DB constraint); command-id de-duplication at the relay and on the Mac; Mac rejects commands outside a 60 s window (server-clock adjusted)                                                                                                                                                                                                                                                                                  |
| Cloud resources                | Runaway cost, data exposure                                                                                  | Per-session hard budget (Anthropic-enforced), per-user concurrency quota, maximum duration sweeper, `limited` networking by default with an explicit host allowlist, web tools off, `auto` permission policy with approvals surfaced on the phone; cloud sandbox has no access to the Mac                                                                                                                                                                               |

## What is _not_ claimed

- **Not end-to-end encrypted.** Phone↔server and server↔Mac are TLS. The CodeBridge server decrypts and relays terminal traffic and could read it while relaying. It does not persist terminal output (only an in-memory replay buffer). Treat the server as trusted infrastructure you operate.
- **No process persistence across reboots.** If the agent or the Mac restarts, running processes are gone and sessions are marked `lost`.
- **Enabling `allowCustomCommands` or `allowInteractiveShell` grants arbitrary code execution as your user** in your workspaces (a determined user can run interpreters). They are off by default and can only be enabled on the Mac.
- **Claude Code permissions** in Claude Code sessions are Claude Code's own (CodeBridge never passes `--dangerously-skip-permissions`).

## Authentication & authorization boundaries

| Endpoint group                                                                                                 | Credential                 | Authorization                                       |
| -------------------------------------------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------- |
| `/v1/auth/*` (register/login/refresh)                                                                          | none / refresh token       | rate-limited                                        |
| `/v1/me`, `/v1/devices*`, `/v1/sessions*`, `/v1/cloud/*`, `/v1/credentials/*`, `/v1/usage`, `/v1/pairing/claim | approve                    | deny`                                               | access token | resource `user_id` must match |
| `/v1/pairing/start`, `/v1/pairing/poll`                                                                        | none / poll secret         | rate-limited; poll secret compared in constant time |
| `/v1/device/*`, `/v1/agent/ws`                                                                                 | device credential          | device must not be revoked                          |
| `/v1/client/ws`                                                                                                | access token (first frame) | per-session ownership checks                        |

## Secret handling & logging

- Logs (API: pino; agent: JSON lines) pass every record through pattern-based redaction (`sk-ant-…`, bearer tokens, `cb*_` tokens, GitHub/AWS/Slack tokens, PEM keys, `*_SECRET=`/`*_TOKEN=`/`PASSWORD=` assignments) plus path-based redaction of auth headers and credential fields. Request logs omit query strings. Tests assert secrets never appear in logs.
- Audit metadata is redacted before insert and never contains terminal output.
- Tool inputs/outputs shown on the phone are redacted.

## Data retention & deletion

| Data                             | Retention                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| Pairings                         | deleted 1 day after expiry                                                           |
| Idempotency records (`commands`) | 7 days                                                                               |
| Revoked/expired auth sessions    | 30 days                                                                              |
| Audit events                     | 365 days (user reference nulled on account deletion)                                 |
| Session metadata, usage          | until account deletion                                                               |
| Terminal output                  | never persisted server-side (in-memory buffer only); kept in the agent's memory ring |

Account deletion (password re-entry required) ends cloud sessions, revokes all devices (closing their sockets), and deletes the user's rows (cascade), including encrypted credentials. Backups: if you back up Postgres, deleted accounts persist in backups until they expire; set your backup retention accordingly and encrypt backups at rest.

## Database access

Use a dedicated Postgres role with privileges only on the CodeBridge database, TLS to the database in production, and no public network exposure. Secrets in the DB are hashes or AES-GCM ciphertext; the encryption key must come from a secrets manager/KMS, not the database host.

## Local health endpoint

`http://127.0.0.1:47821/health` (configurable, `0` disables) binds to loopback only, rejects non-loopback peers and foreign `Host` headers (DNS-rebinding protection), and exposes only connection state and session counts.

## Reporting

Please report vulnerabilities privately to the repository owner rather than in public issues.

## Creating projects from the phone

Workspaces were originally add-on-the-computer-only. The phone can now start a new project, under tight limits:

- The command carries **only a name** (`workspace.create`). The location is never supplied by the phone: the agent creates the folder directly inside its own projects folder (`policy.projectsRoot`, default `~/CodeBridge`).
- Names are validated by the shared schema and again on the computer (letters, numbers, spaces, `.`, `-`, `_`; no `..`, no separators, no leading dot, 64 characters, Windows reserved names refused).
- The folder is created with a non-recursive `mkdir`, so an existing folder, file or symlink is **never adopted**; the real path is re-checked to be a plain directory inside the real projects folder.
- It cannot widen access to existing data. At most 100 workspaces; the owner can turn it off (`allowWorkspaceCreation false`), and the agent advertises the setting so the app hides the button.
- Every request is audited (`workspace.create`) on the relay.

## Adding an existing folder from the phone

The phone can also pick a folder that already exists on the computer, so Claude Code can work on a real project. This **does** widen what a paired phone can reach (an existing folder, not just a brand-new one), so it is limited and switchable:

- **Only inside your home directory.** Browsing starts at the home folder and cannot leave it. `workspace.browse` lists sub-folders only (never files), skips hidden folders (`.ssh`, `.config`, …), app-data folders (`Library`, `AppData`) and `node_modules`, and ignores symlinks, which could point elsewhere.
- **Re-checked on the computer.** Both `workspace.browse` and `workspace.add` resolve the path through symlinks and apply these rules again, whatever the phone or relay sent. The home folder itself, system folders and anything outside home are refused, using the same checks as `codebridge-agent workspace add`.
- **Owner switch.** `codebridge-agent policy set allowFolderBrowse false` turns it off; the agent advertises the setting so the app hides the button. At most 100 workspaces.
- **Audited.** `workspace.add` is recorded on the relay.

A folder that is added can then be used by any session mode you allow on that computer, so keep the other switches (`allowCustomCommands`, `allowInteractiveShell`) off unless you need them.
