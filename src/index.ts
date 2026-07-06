#!/usr/bin/env node

import { startNoMoreIdeMcpServer } from "./mcp/server.js";
import { createTuiApp } from "./tui/app.js";
import { createWebServer } from "./web/server.js";
import { runCli } from "./cli/commands.js";

const command = process.argv[2] ?? "mcp";

if (command === "mcp" || (command === "start" && process.argv.length <= 3)) {
  await startNoMoreIdeMcpServer();
} else if (command === "tui") {
  await createTuiApp().start();
} else if (command === "web") {
  const portArg = process.argv.find((arg) => arg.startsWith("--port="));
  const port = portArg ? Number(portArg.slice("--port=".length)) : undefined;
  const server = await createWebServer({ port }).start();
  console.error(`NoMoreIDE web UI: ${server.url}`);
} else if (
  [
    "add",
    "agents",
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
    "Usage: nomoreide [mcp|setup|tui|web|git|agents|profile|list|logs|start|stop|restart|add]",
  );
  process.exitCode = 1;
}
