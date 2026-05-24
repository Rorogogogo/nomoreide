# NoMoreIDE Web Terminal Design

## Goal

Add a terminal page to the NoMoreIDE web UI that gives the user a real local shell inside the browser. The terminal should feel close to a normal terminal: live output, ANSI colors, interactive stdin, Ctrl+C, scrollback, and resize handling.

## Product Scope

The first version is a single local terminal session owned by the current NoMoreIDE web server process. It runs only on localhost and defaults to a project or selected repository working directory. It does not support remote terminals, persisted sessions, multiple tabs, command approval workflows, or sharing terminal sessions between browser clients.

## User Experience

The sidebar gets a Terminal entry. The page is dominated by a full-height terminal pane with a compact header showing the active working directory and session state. The user can focus the terminal, type normal shell commands, resize the browser, and stop or restart the session from header controls.

When the page opens, the app creates or attaches to the current terminal session. If the session has not started, the server creates a PTY using the user's default shell. Closing the browser tab detaches the UI but leaves the single server-owned session running until the user stops it, restarts it, it exits naturally, or the NoMoreIDE server shuts down.

## Architecture

The client uses `xterm.js` for terminal rendering and `@xterm/addon-fit` for resize behavior. A new `features/terminal/` module owns the React view, terminal lifecycle hook, and API transport code.

The server uses `node-pty` to spawn a real pseudoterminal. A new core module, `core/terminal-session.ts`, owns the PTY process, active session metadata, input writes, resize events, output subscriptions, and cleanup. A new route module, `web/routes/terminal-routes.ts`, exposes the browser transport and is registered in `web/routes/index.ts`.

## Transport

Use WebSocket. The web server handles the upgrade for the terminal endpoint and gives the terminal feature one bidirectional channel for output, input, resize, and control messages. Normal HTTP route dispatch remains responsible for the rest of the dashboard.

## Message Model

The browser sends:

- `input`: raw text typed or pasted into the terminal.
- `resize`: terminal columns and rows.
- `restart`: terminate the current PTY and create a fresh one.
- `stop`: terminate the current PTY.

The server sends:

- `output`: raw PTY output bytes decoded as text for xterm.
- `state`: session metadata such as `starting`, `running`, `exited`, or `error`.
- `error`: transport or spawn errors that should be surfaced in the terminal page.

## Safety

This feature is intentionally full local shell access. The UI must make the active working directory visible, and the server should bind only to localhost as it does today. The terminal routes should not expose filesystem browsing or remote execution beyond what the shell itself can do for the local user.

The first version should avoid hidden command execution. Session creation is explicit from the Terminal page, and restart/stop controls are visible. NoMoreIDE should clean up the PTY on server shutdown.

## Error Handling

If `node-pty` cannot be loaded or the user's shell cannot be spawned, the terminal page shows a clear error state and the rest of the dashboard remains usable. If the PTY exits, the terminal should display the exit state and offer a restart action.

Transport disconnects should not crash the server. Reconnect behavior is deterministic: if the single active session is still running, the browser reattaches to it; otherwise the browser shows the exited state and offers restart.

## Testing

Core tests cover PTY session lifecycle through an injectable PTY adapter so tests do not depend on a native terminal. Route tests cover session creation, input forwarding, resize forwarding, stop/restart behavior, and error responses. Client tests cover the Terminal page rendering, connection state, and user controls with the xterm dependency mocked.

Manual verification should run the web UI, open `/terminal`, execute simple commands such as `pwd` and `echo ok`, verify ANSI output, send Ctrl+C to a long-running command, resize the browser, and stop/restart the session.
