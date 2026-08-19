import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { buildServiceAgentContext } from "../../core/agent-context.js";
import { computeServiceHealth } from "../../core/service-health.js";
import type { NoMoreIdeConfig } from "../../core/types.js";
import { stringify, type ToolContext } from "./context.js";

export const SERVICE_TOOL_NAMES = [
  "nomoreide_list_services",
  "nomoreide_register_service",
  "nomoreide_start_service",
  "nomoreide_stop_service",
  "nomoreide_restart_service",
  "nomoreide_read_logs",
  "nomoreide_register_bundle",
  "nomoreide_start_bundle",
  "nomoreide_stop_bundle",
  "nomoreide_status",
  "nomoreide_service_context",
  "nomoreide_service_health",
  "nomoreide_timeline",
] as const;

const serviceNameSchema = z.object({
  name: z.string().min(1).describe("Registered service name."),
});

const bundleNameSchema = z.object({
  name: z.string().min(1).describe("Registered bundle name."),
});

export function buildServiceDiscovery(
  config: Pick<NoMoreIdeConfig, "services" | "bundles">,
): Record<string, unknown> {
  return {
    services: config.services.map(({ env, ...service }) => ({
      ...service,
      ...(env ? { envKeys: Object.keys(env).sort() } : {}),
    })),
    bundles: config.bundles,
  };
}

/**
 * Runtime tools (start/stop/logs/status/…) call the machine-global daemon
 * over HTTP so every session shares the same services; registration tools
 * write config locally — the daemon re-reads it from disk on every operation.
 */
export function registerServiceTools(
  server: FastMCP,
  ctx: ToolContext,
): void {
  const { configStore, daemon } = ctx;

  server.addTool({
    name: "nomoreide_list_services",
    description:
      "Discover registered NoMoreIDE services and bundles before running, starting, debugging, diagnosing, or troubleshooting a development project.",
    execute: async () => stringify(buildServiceDiscovery(await configStore.load())),
  });

  server.addTool({
    name: "nomoreide_register_service",
    description:
      "Register or replace a development service (local, docker-compose, or ssh). For ssh, NoMoreIDE relies on the user's ~/.ssh/config and ssh-agent and never stores key material; pass a Host alias as `host`.",
    parameters: z.object({
      name: z.string().min(1),
      kind: z.enum(["local", "docker-compose", "ssh"]).optional(),
      command: z.string().min(1).optional(),
      args: z
        .array(z.string())
        .optional()
        .describe("When present, execute command directly with these arguments instead of through a shell."),
      cwd: z.string().min(1).optional(),
      port: z.number().int().positive().max(65535).optional(),
      env: z.record(z.string()).optional(),
      description: z.string().optional(),
      composeFile: z.string().min(1).optional(),
      composeService: z.string().min(1).optional(),
      host: z.string().min(1).optional(),
    }),
    execute: async (args) => stringify(await configStore.registerService(args)),
  });

  server.addTool({
    name: "nomoreide_start_service",
    description:
      "Run or start a registered development service in the shared NoMoreIDE daemon so it survives this session; prefer this over launching a duplicate ad-hoc process.",
    parameters: serviceNameSchema,
    execute: async ({ name }) =>
      stringify(await (await daemon.client()).startService(name)),
  });

  server.addTool({
    name: "nomoreide_stop_service",
    description: "Stop a running NoMoreIDE service.",
    parameters: serviceNameSchema,
    execute: async ({ name }) =>
      stringify(await (await daemon.client()).stopService(name)),
  });

  server.addTool({
    name: "nomoreide_restart_service",
    description:
      "Restart a registered service through the shared daemon while debugging or recovering an unhealthy service.",
    parameters: serviceNameSchema,
    execute: async ({ name }) =>
      stringify(await (await daemon.client()).restartService(name)),
  });

  server.addTool({
    name: "nomoreide_read_logs",
    description:
      "Inspect recent logs while debugging or troubleshooting a registered service, regardless of which session started it in the shared daemon.",
    parameters: z.object({
      name: z.string().min(1),
      limit: z.number().int().positive().max(1000).optional(),
    }),
    execute: async ({ name, limit }) =>
      stringify(await (await daemon.client()).logs(name, limit ?? 500)),
  });

  server.addTool({
    name: "nomoreide_register_bundle",
    description: "Register or replace a bundle of services.",
    parameters: z.object({
      name: z.string().min(1),
      services: z.array(z.string().min(1)).min(1),
    }),
    execute: async (args) => stringify(await configStore.registerBundle(args)),
  });

  server.addTool({
    name: "nomoreide_start_bundle",
    description:
      "Run or start every service in a registered development bundle through the shared NoMoreIDE daemon.",
    parameters: bundleNameSchema,
    execute: async ({ name }) =>
      stringify(await (await daemon.client()).startBundle(name)),
  });

  server.addTool({
    name: "nomoreide_stop_bundle",
    description: "Stop every service in a registered bundle.",
    parameters: bundleNameSchema,
    execute: async ({ name }) =>
      stringify(await (await daemon.client()).stopBundle(name)),
  });

  server.addTool({
    name: "nomoreide_status",
    description:
      "Inspect current shared runtime status before running, debugging, restarting, or troubleshooting services.",
    execute: async () => stringify(await (await daemon.client()).status()),
  });

  server.addTool({
    name: "nomoreide_service_context",
    description:
      "Build a debugging context packet with the service definition, runtime status, health summary, recent logs, and timeline for a registered service.",
    parameters: serviceNameSchema,
    execute: async ({ name }) => {
      const config = await configStore.load();
      const definition = config.services.find((service) => service.name === name);
      if (!definition) {
        throw new Error(`Service "${name}" is not registered.`);
      }
      const client = await daemon.client();
      const [runtime, logs, timelineEvents] = await Promise.all([
        client.status(),
        client.logs(name, 80),
        client.timeline(200),
      ]);
      const status = runtime.services[name];
      const timeline = timelineEvents.filter((event) => event.service === name);
      const health = computeServiceHealth({
        service: definition,
        status,
        logs,
        ports: [],
        timeline,
      });
      return buildServiceAgentContext({
        service: definition,
        status,
        healthSummary: health.summary,
        recentLogs: logs,
        timeline,
      });
    },
  });

  server.addTool({
    name: "nomoreide_service_health",
    description:
      "Diagnose one or all registered services with computed health summaries before restart or repair decisions.",
    parameters: z.object({
      service: z.string().min(1).optional(),
    }),
    execute: async ({ service }) => {
      const config = await configStore.load();
      const definitions = service
        ? config.services.filter((item) => item.name === service)
        : config.services;
      if (service && definitions.length === 0) {
        throw new Error(`Service "${service}" is not registered.`);
      }
      const client = await daemon.client();
      const [runtime, timeline] = await Promise.all([
        client.status(),
        client.timeline(200),
      ]);
      const health = await Promise.all(
        definitions.map(async (definition) =>
          computeServiceHealth({
            service: definition,
            status: runtime.services[definition.name],
            logs: await client.logs(definition.name, 80),
            ports: [],
            timeline: timeline.filter((event) => event.service === definition.name),
          }),
        ),
      );
      return stringify(service ? health[0] : health);
    },
  });

  server.addTool({
    name: "nomoreide_timeline",
    description:
      "Return recent NoMoreIDE debug timeline events, optionally filtered by service.",
    parameters: z.object({
      service: z.string().min(1).optional(),
      limit: z.number().int().positive().max(200).default(80),
    }),
    execute: async ({ service, limit }) => {
      const events = await (await daemon.client()).timeline(200);
      const filtered = service
        ? events.filter((event) => event.service === service)
        : events;
      return stringify(filtered.slice(-limit));
    },
  });
}
