import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { buildServiceAgentContext } from "../../core/agent-context.js";
import { computeServiceHealth } from "../../core/service-health.js";
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

export function registerServiceTools(
  server: FastMCP,
  ctx: ToolContext,
): void {
  const { configStore, logStore, manager, timelineStore } = ctx;

  server.addTool({
    name: "nomoreide_list_services",
    description: "List registered NoMoreIDE services and bundles.",
    execute: async () => stringify(await configStore.load()),
  });

  server.addTool({
    name: "nomoreide_register_service",
    description:
      "Register or replace a development service (local, docker-compose, or ssh). For ssh, NoMoreIDE relies on the user's ~/.ssh/config and ssh-agent and never stores key material; pass a Host alias as `host`.",
    parameters: z.object({
      name: z.string().min(1),
      kind: z.enum(["local", "docker-compose", "ssh"]).optional(),
      command: z.string().min(1).optional(),
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
    description: "Start a registered service.",
    parameters: serviceNameSchema,
    execute: async ({ name }) => stringify(await manager.startService(name)),
  });

  server.addTool({
    name: "nomoreide_stop_service",
    description: "Stop a running NoMoreIDE service.",
    parameters: serviceNameSchema,
    execute: async ({ name }) => stringify(await manager.stopService(name)),
  });

  server.addTool({
    name: "nomoreide_restart_service",
    description: "Restart a registered service.",
    parameters: serviceNameSchema,
    execute: async ({ name }) => stringify(await manager.restartService(name)),
  });

  server.addTool({
    name: "nomoreide_read_logs",
    description: "Read recent in-memory logs for a registered service.",
    parameters: z.object({
      name: z.string().min(1),
      limit: z.number().int().positive().max(1000).optional(),
    }),
    execute: async ({ name, limit }) => stringify(logStore.read(name, limit)),
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
    description: "Start every service in a registered bundle.",
    parameters: bundleNameSchema,
    execute: async ({ name }) => stringify(await manager.startBundle(name)),
  });

  server.addTool({
    name: "nomoreide_stop_bundle",
    description: "Stop every service in a registered bundle.",
    parameters: bundleNameSchema,
    execute: async ({ name }) => stringify(await manager.stopBundle(name)),
  });

  server.addTool({
    name: "nomoreide_status",
    description: "Show current NoMoreIDE runtime status.",
    execute: async () => stringify(manager.status()),
  });

  server.addTool({
    name: "nomoreide_service_context",
    description:
      "Build a copy-paste agent context packet (service definition, runtime status, health summary, recent logs and timeline) for a registered service.",
    parameters: serviceNameSchema,
    execute: async ({ name }) => {
      const config = await configStore.load();
      const definition = config.services.find((service) => service.name === name);
      if (!definition) {
        throw new Error(`Service "${name}" is not registered.`);
      }
      const runtime = await manager.statusWithResources();
      const status = runtime.services[name];
      const logs = logStore.read(name, 80);
      const timeline = timelineStore
        .read(200)
        .filter((event) => event.service === name);
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
      "Return computed health summaries for one service or all registered services.",
    parameters: z.object({
      service: z.string().min(1).optional(),
    }),
    execute: async ({ service }) => {
      const config = await configStore.load();
      const runtime = await manager.statusWithResources();
      const timeline = timelineStore.read(200);
      const definitions = service
        ? config.services.filter((item) => item.name === service)
        : config.services;
      if (service && definitions.length === 0) {
        throw new Error(`Service "${service}" is not registered.`);
      }
      const health = definitions.map((definition) =>
        computeServiceHealth({
          service: definition,
          status: runtime.services[definition.name],
          logs: logStore.read(definition.name, 80),
          ports: [],
          timeline: timeline.filter((event) => event.service === definition.name),
        }),
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
      const events = timelineStore.read(200);
      const filtered = service
        ? events.filter((event) => event.service === service)
        : events;
      return stringify(filtered.slice(-limit));
    },
  });
}
