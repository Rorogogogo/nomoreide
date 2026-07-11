import readline from "node:readline";
import { ConfigStore, defaultGlobalConfigPath } from "../core/config-store.js";
import {
  createDaemonConnection,
  type DaemonConnection,
} from "../core/daemon-client.js";
import type { NoMoreIdeStatus } from "../core/process-manager.js";
import type { NoMoreIdeConfig, LogEntry } from "../core/types.js";

export type TuiMode = "services" | "bundles" | "logs";

export interface TuiScreenState {
  mode: TuiMode;
  selectedIndex: number;
  selectedService?: string;
  config: NoMoreIdeConfig;
  runtime: NoMoreIdeStatus;
  logs: LogEntry[];
}

export interface TuiAppOptions {
  configPath?: string;
  /** Injectable for tests; defaults to the machine-global daemon. */
  daemon?: DaemonConnection;
}

export interface TuiApp {
  start(): Promise<void>;
}

export function createTuiApp(options: TuiAppOptions = {}): TuiApp {
  const configStore = new ConfigStore(
    options.configPath ?? defaultGlobalConfigPath(),
  );
  // The TUI is a daemon client: services keep running after it quits and
  // logs/status reflect every session's services, not just this one's.
  const daemon = options.daemon ?? createDaemonConnection();

  return {
    async start() {
      await runTui({ configStore, daemon });
    },
  };
}

export function renderTuiScreen(state: TuiScreenState): string {
  const lines = [
    "NoMoreIDE",
    "s start   x stop   r restart   b bundles   l logs   q quit",
    "",
  ];

  if (state.mode === "bundles") {
    lines.push("Bundles");
    for (const [index, bundle] of state.config.bundles.entries()) {
      const marker = index === state.selectedIndex ? ">" : " ";
      lines.push(`${marker} ${bundle.name}  [${bundle.services.join(", ")}]`);
    }
  } else if (state.mode === "logs") {
    lines.push(`Logs ${state.selectedService ? `- ${state.selectedService}` : ""}`);
    for (const entry of state.logs.slice(-20)) {
      lines.push(`${entry.timestamp} ${entry.stream.padEnd(6)} ${entry.text}`);
    }
  } else {
    lines.push("Services");
    for (const [index, service] of state.config.services.entries()) {
      const marker = index === state.selectedIndex ? ">" : " ";
      const status = state.runtime.services[service.name]?.state ?? "stopped";
      const port = service.port ? String(service.port) : "-";
      const description = service.description ? ` ${service.description}` : "";
      lines.push(
        `${marker} ${service.name.padEnd(18)} ${status.padEnd(8)} port ${port.padEnd(5)}${description}`,
      );
    }

    lines.push("");
    lines.push("Bundles");
    for (const bundle of state.config.bundles) {
      lines.push(`  ${bundle.name}  [${bundle.services.join(", ")}]`);
    }
  }

  return `${lines.join("\n")}\n`;
}

async function runTui(options: {
  configStore: ConfigStore;
  daemon: DaemonConnection;
}): Promise<void> {
  let mode: TuiMode = "services";
  let selectedIndex = 0;
  let selectedService: string | undefined;

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  const render = async () => {
    const config = await options.configStore.load();
    const client = await options.daemon.client();
    const currentService =
      selectedService ?? config.services[Math.max(0, selectedIndex)]?.name;
    const [runtime, logs] = await Promise.all([
      client.status(),
      currentService ? client.logs(currentService) : Promise.resolve([]),
    ]);
    const output = renderTuiScreen({
      mode,
      selectedIndex,
      selectedService: currentService,
      config,
      runtime,
      logs,
    });

    process.stdout.write("\x1Bc");
    process.stdout.write(output);
  };

  await render();

  await new Promise<void>((resolve) => {
    process.stdin.on("keypress", async (_input, key) => {
      const config = await options.configStore.load();
      const services = config.services;
      const bundles = config.bundles;
      const service = services[selectedIndex];
      const bundle = bundles[selectedIndex];

      if (key.name === "q" || (key.ctrl && key.name === "c")) {
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        // Services belong to the daemon and keep running after the TUI exits.
        resolve();
        return;
      }

      const client = await options.daemon.client();
      if (key.name === "up") {
        selectedIndex = Math.max(0, selectedIndex - 1);
      } else if (key.name === "down") {
        const max = mode === "bundles" ? bundles.length - 1 : services.length - 1;
        selectedIndex = Math.min(Math.max(0, max), selectedIndex + 1);
      } else if (key.name === "b") {
        mode = mode === "bundles" ? "services" : "bundles";
        selectedIndex = 0;
      } else if (key.name === "l" && service) {
        mode = "logs";
        selectedService = service.name;
      } else if (key.name === "escape") {
        mode = "services";
      } else if (key.name === "s") {
        if (mode === "bundles" && bundle) {
          await client.startBundle(bundle.name);
        } else if (service) {
          await client.startService(service.name);
        }
      } else if (key.name === "x") {
        if (mode === "bundles" && bundle) {
          await client.stopBundle(bundle.name);
        } else if (service) {
          await client.stopService(service.name);
        }
      } else if (key.name === "r") {
        if (service) {
          await client.restartService(service.name);
        }
      }

      await render();
    });
  });
}
