# codebridge-agent

The CodeBridge agent runs on **your own Mac or Windows PC** and lets the CodeBridge phone app start and
supervise coding sessions there: terminals, git, and Claude Code, inside only the folders you approve.

Your code, your tools and your Claude login stay on this computer. The agent makes an outbound connection to
your CodeBridge server; nothing is opened inbound.

## Requirements

- macOS 13+ or Windows 10 (1809) / 11
- [Node.js 22 or newer](https://nodejs.org/)
- Optional, for Claude Code sessions: [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and
  signed in (run `claude` once). Sessions use that login, so they count against your own Claude plan. The agent
  never reads or forwards it.

## Install

```bash
npm install -g codebridge-agent
```

## Set up

```bash
codebridge-agent pair --server https://your-codebridge-server   # shows a QR code and a code to approve in the app
codebridge-agent workspace add ~/code/my-project                # Windows: C:\Users\you\code\my-project
codebridge-agent service install                                # start at login and restart on failure
codebridge-agent status
```

`service install` creates a LaunchAgent on macOS and a per-user scheduled task on Windows (no administrator
rights, no Windows Service). To run in the foreground instead: `codebridge-agent run`.

## Safety defaults

- Only registered workspace folders are reachable. System folders and your whole home directory are refused.
- Your phone can start a **new project** by name. The agent creates a brand-new folder inside its projects folder (`~/CodeBridge`, or `codebridge-agent policy set projectsRoot <dir>`), never reuses an existing folder, and registers it. Turn it off with `codebridge-agent policy set allowWorkspaceCreation false`.
- Commands from the phone are limited to presets unless you turn on `allowCustomCommands`; risky programs
  need approval on the phone and some (`sudo`, `diskpart`, `reg`, …) are never run.
- Interactive shells are off until you run `codebridge-agent policy set allowInteractiveShell true`.
- Secrets live in the OS credential store (Keychain on macOS, Credential Manager on Windows).
- The agent refuses to run as root.

## Windows notes

- Commands such as `npm test` run through `cmd.exe`; arguments containing `& | < > ^ % ! "` are rejected rather
  than escaped.
- Logs: `%LOCALAPPDATA%\CodeBridge\Logs\agent.log`. Config: `%APPDATA%\CodeBridge`.
- Claude Code has its own Windows requirements (see its documentation).

## Uninstall

```bash
codebridge-agent unpair
codebridge-agent credentials clear
codebridge-agent service uninstall
npm uninstall -g codebridge-agent
```

Set `CODEBRIDGE_HOME` to move the config directory.

## License

MIT
