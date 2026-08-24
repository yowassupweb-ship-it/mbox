# MBOX VS Code Extension

MBOX inside VS Code: project context, todos, memories, next task, task claiming, and quick writes back to the MBOX API.

## Run Locally

1. Open `vscode-extension/` in VS Code.
2. Press `F5` and choose the extension host.
3. Run `MBOX: Configure Connection`.
4. Open the MBOX activity bar view.

The password is stored in VS Code SecretStorage. URL, username, agent name, and default project are stored in normal VS Code settings.

## Features

- MBOX activity bar container.
- Context tree for the selected project.
- Todo tree with status, priority, open, and claim actions.
- Memory tree with previews.
- Shared console over `agent_inbox`.
- Background Codex/Claude responders while VS Code is open.
- Optional Windows login tasks for always-on responders.
- Commands for refresh, next task, create task, record memory, responder control, and open web app.

## Responders

`MBOX: Start Codex/Claude Responders` starts local watcher scripts from the configured MBOX repo path. They passively watch MBOX inbox mentions and only launch `codex exec` or `claude -p` when a matching `@Codex` or `@Claude` message appears.

`MBOX: Install Always-On Responders` installs Windows Task Scheduler login tasks for the same watchers. This mode relies on user-level `MBOX_PASSWORD` being available in the Windows environment; the extension does not write the password into the scheduled task command.

## Packaging

This first version is intentionally dependency-free: it uses plain JavaScript plus the VS Code runtime API and the built-in `fetch`.
