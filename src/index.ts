#!/usr/bin/env node

import { startNoMoreIdeMcpServer } from "./mcp/server.js";
import { createTuiApp } from "./tui/app.js";
import { ensureDaemon } from "./core/daemon-lifecycle.js";
import { runCli } from "./cli/commands.js";
import { runDaemonCli } from "./cli/daemon.js";
import { runExternalTerminalAttach } from "./core/external-terminal.js";

const command = process.argv[2] ?? "mcp";

if (command === "__terminal-attach") {
  const socketPath = process.argv[3] ?? "";
  const token = process.argv[4] ?? "";
  try {
    await runExternalTerminalAttach(socketPath, token);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} else if (command === "mcp" || (command === "start" && process.argv.length <= 3)) {
  await startNoMoreIdeMcpServer();
} else if (command === "tui") {
  await createTuiApp().start();
} else if (command === "daemon") {
  process.exitCode = await runDaemonCli(process.argv.slice(3));
} else if (command === "web") {
  const portArg = process.argv.find((arg) => arg.startsWith("--port="));
  const port = portArg ? Number(portArg.slice("--port=".length)) : undefined;
  const result = await ensureDaemon({ port });
  if (result.versionWarning) console.error(result.versionWarning);
  console.error(`NoMoreIDE web UI: ${result.url}`);
} else if (
  [
    "add",
    "agents",
    "db",
    "git",
    "list",
    "logs",
    "profile",
    "setup",
    "start",
    "stop",
    "restart",
  ].includes(command)
) {
  process.exitCode = await runCli(process.argv.slice(2));
} else {
  console.error(
    "Usage: nomoreide [mcp|setup|tui|web|daemon|git|db|agents|profile|list|logs|start|stop|restart|add]",
  );
  process.exitCode = 1;
}
