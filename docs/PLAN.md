# Implementation plan & status

The repository started as an empty README. The plan prioritised a secure, working local Mac session before advanced features.

## Milestones

| #   | Milestone                                            | Acceptance criteria                                                                                                                                                                                                      | Status                                                                                                                     |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | Protocol & foundations                               | Shared zod schemas for every frame; limits; redaction; CI-ready tooling                                                                                                                                                  | ✅                                                                                                                         |
| 2   | Accounts & pairing                                   | Register/login/refresh rotation/logout/delete; RFC 8628-style pairing with expiry, single use, local confirmation; revocation; rotation                                                                                  | ✅ tested                                                                                                                  |
| 3   | Relay & local sessions (**first working milestone**) | Mac agent authenticates outbound; phone pairs; workspace selection; approved command runs in a PTY; output reaches the phone through an authenticated connection; unauthorized access rejected; secrets absent from logs | ✅ tested (integration, end-to-end with the real agent, and in a browser)                                                  |
| 4   | Resilience                                           | Ordered, de-duplicated events; replay after phone and Mac reconnects; `lost` sessions after restarts; idempotent commands                                                                                                | ✅ tested                                                                                                                  |
| 5   | Coding agent (Messages API)                          | Streaming, bounded tool loop, workspace-confined tools, approvals, cancellation, rate-limit/auth errors, usage & cost                                                                                                    | ✅ tested with a mocked API                                                                                                |
| 6   | Claude Code CLI provider                             | Headless CLI sessions with the CLI's own login                                                                                                                                                                           | ✅ parsing tested with mocked output; not exercised against a logged-in CLI                                                |
| 7   | Managed cloud sessions                               | Create, inspect, stream, approve, prompt, interrupt, end; budgets, quotas, cleanup; separate from local state                                                                                                            | ✅ tested with a mocked provider; live test written, **not run** (no key available)                                        |
| 8   | Mobile app                                           | 15 screens, dark mode, accessible controls, terminal & chat, loading/error/offline states                                                                                                                                | ✅ unit/UI tests; web build E2E in Chromium; native JS bundles compile; **not run on a physical device or simulator** here |
| 9   | Docs, infra, CI                                      | Architecture/security/API/dev/deploy docs; Compose; Dockerfile; GitHub Actions                                                                                                                                           | ✅ written; Docker not executed here                                                                                       |

## Risks and how they were handled

- **Remote code execution** — decisions live on the Mac; defaults are presets-only; switches are local-only. See SECURITY.md.
- **API drift** — Anthropic usage verified against the current SDK (1.3.0) and Anthropic's API skill docs before coding: adaptive thinking, `output_config.effort`, server-side fallbacks, eager input streaming with client validation, Managed Agents agent→environment→session flow, `requires_action` confirmations, budgets, archive.
- **Unsupported capabilities** — CodeBridge does not attach to existing Claude.ai or Claude Code sessions (no supported API). Cloud sessions are always new, CodeBridge-managed sessions.
- **Expo/RN version churn** — versions pinned to Expo SDK 58's `bundledNativeModules`.

## Known limitations / remaining work

1. Relay is single-instance (no Redis fan-out yet).
2. Terminal renderer handles line-oriented output, colours and carriage returns; full-screen TUIs (vim, htop) don't render faithfully. An xterm.js-in-WebView renderer would fix this.
3. Cloud sessions don't mount the user's repositories (Managed Agents supports GitHub repository resources; adding a vault-backed GitHub credential flow is future work).
4. Coding-agent conversation history lives in the agent's memory; long sessions may hit context limits (server-side compaction is not enabled yet) and history is lost on agent restart.
5. Approvals for model-initiated actions have a 10-minute timeout (treated as rejection); there is no per-session "auto-approve edits" toggle yet.
6. No push notifications for "approval needed" while the app is backgrounded.
7. Mac agent distribution is from source (no signed installer).
8. Credential-encryption key rotation requires users to re-enter cloud keys.
9. No email verification or password reset flow yet; consider an identity provider for production.
