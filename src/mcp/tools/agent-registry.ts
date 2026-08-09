import type { FastMCP } from "fastmcp";
import { z } from "zod";
import {
  createRegistryClient,
  createRegistryTokenManager,
  installProfileFromRegistry,
  publishProfileToRegistry,
  resolveRegistryApiBaseUrl,
  resolveRegistryApiToken,
} from "../../core/agent-profiles/index.js";
import { stringify, type ToolContext } from "./context.js";

export const AGENT_REGISTRY_TOOL_NAMES = [
  "nomoreide_profiles_publish",
  "nomoreide_profiles_install_from_registry",
  "nomoreide_profiles_register_github",
] as const;

/**
 * Hosted profile registry (ROR-63; the brainctl platform, kept as-is).
 * Auth comes from the stored registry sign-in (`~/.nomoreide/config.json`) or
 * `NOMOREIDE_API_TOKEN` — sign-in itself is a browser flow in the web UI.
 */
export function registerAgentRegistryTools(server: FastMCP, _ctx: ToolContext): void {
  const tokenManager = createRegistryTokenManager();
  const authenticatedFetch = (input: string | URL | Request, init?: RequestInit) =>
    tokenManager.authenticatedFetch(typeof input === "string" ? input : input.toString(), init);

  async function requireToken(): Promise<void> {
    if ((await tokenManager.getAccessToken()) === null) {
      throw new Error(
        "Not signed in to the profile registry. Sign in from the web UI (Agent Environments → Registry) or set NOMOREIDE_API_TOKEN.",
      );
    }
  }

  server.addTool({
    name: "nomoreide_profiles_publish",
    description:
      "Publish a saved profile to the hosted registry so others can install it by slug. Uploads the credential-redacted export archive — raw secrets never leave the machine.",
    parameters: z.object({
      name: z.string().min(1).describe("Local profile name."),
      slug: z.string().min(1).describe("Registry slug to publish under."),
      title: z.string().min(1),
      summary: z.string().optional(),
      version: z.string().optional().describe("Defaults to 1.0.0."),
      changelog: z.string().optional(),
      visibility: z.enum(["public", "private"]).default("public"),
      cwd: z.string().min(1).optional().describe("Project directory (defaults to the server's cwd)."),
    }),
    execute: async (input) => {
      await requireToken();
      return stringify(
        await publishProfileToRegistry({
          ...input,
          cwd: input.cwd ?? process.cwd(),
          apiBaseUrl: await resolveRegistryApiBaseUrl(),
          fetch: authenticatedFetch,
        }),
      );
    },
  });

  server.addTool({
    name: "nomoreide_profiles_install_from_registry",
    description:
      "Install a published profile from the hosted registry by slug. Supplied credentials (or matching environment variables) fill ${credentials.*} placeholders; unresolved keys are reported.",
    parameters: z.object({
      slug: z.string().min(1),
      force: z.boolean().default(false).describe("Overwrite an existing profile of the same name."),
      as: z.string().optional().describe("Install under a different local profile name."),
      credentials: z.record(z.string()).optional(),
    }),
    execute: async (input) =>
      stringify(
        await installProfileFromRegistry({
          ...input,
          apiBaseUrl: await resolveRegistryApiBaseUrl(),
          token: (await resolveRegistryApiToken())?.token,
        }),
      ),
  });

  server.addTool({
    name: "nomoreide_profiles_register_github",
    description:
      "Register a GitHub repository as a registry profile — the registry serves it without a package upload (free sharing path).",
    parameters: z.object({
      repoUrl: z.string().min(1).describe("GitHub repository URL."),
      slug: z.string().min(1),
      title: z.string().min(1),
      summary: z.string().optional(),
      refName: z.string().optional().describe("Branch or tag (defaults to main)."),
      profilePath: z.string().optional().describe("Path to the profile file inside the repo."),
    }),
    execute: async (input) => {
      await requireToken();
      const client = createRegistryClient({
        baseUrl: await resolveRegistryApiBaseUrl(),
        fetch: authenticatedFetch,
      });
      return stringify(
        await client.registerGithubProfile({ ...input, manifestJson: { name: input.slug } }),
      );
    },
  });
}
