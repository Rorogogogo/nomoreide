import {
  CLOUDFLARE_ACTIONS,
  PRODUCTION_AFFECTING_ACTIONS,
  type CloudflareActions,
} from "./cloudflare-actions.js";
import { CLOUDFLARE_PROVIDER_ID } from "./cloudflare-auth.js";
import {
  cloudflareRepoUrl,
  type CloudflareBuildLogLine,
  type CloudflareDeployment,
  type CloudflareDomain,
  type CloudflareEnvVar,
  type CloudflareManager,
  type CloudflareProject,
} from "./cloudflare-manager.js";
import type {
  DeployActionInput,
  DeployActionResult,
  DeployProvider,
  DeployProviderActions,
  DeployProviderHooks,
  DeployProviderManifest,
  ProviderDeployment,
  ProviderDeploymentDetail,
  ProviderDeploymentState,
  ProviderDomain,
  ProviderEnvVar,
  ProviderLogLine,
  ProviderProject,
  ProviderSetting,
} from "./providers/deploy-provider.js";

/**
 * Cloudflare Pages as `DeployProvider` implementation #2 — the one that tests
 * whether the contract was shaped by the problem or by Vercel.
 *
 * A pure adapter, like `vercel-provider.ts`: every method delegates to
 * `CloudflareManager` or `CloudflareActions` and only reshapes the result.
 *
 * Three places the contract had to absorb a genuinely different vendor, all
 * without changing a signature:
 *
 * 1. **Deployment reads are project-scoped.** Cloudflare has no global
 *    deployment endpoint, so {@link createCloudflareDeployProvider} closes over
 *    the project the caller already resolved rather than widening
 *    `getDeployment(id)` to take one. `ProviderContext` bundles a provider with
 *    its project anyway, so this costs the callers nothing.
 * 2. **`rawState` earns its keep immediately.** Cloudflare's state is a
 *    (stage, status) pair, not an enum — there is no eight-value list to map
 *    from, so the pair is carried through as `stage:status` and the neutral
 *    state is computed.
 * 3. **`ProviderProject.id` is whatever the vendor addresses projects by.**
 *    Cloudflare's paths use the project *name*, so that is the id here and its
 *    UUID is not exposed. Pinning a project in config therefore stores a name.
 */

export const CLOUDFLARE_MANIFEST: DeployProviderManifest = {
  id: CLOUDFLARE_PROVIDER_ID,
  name: "Cloudflare",
  kind: "deploy",
  scopeLabel: "Account",
  authSources: ["cli", "stored"],
  // No `runtimeLogs`: Pages serves runtime output over a websocket tail, not a
  // REST read, so the tab is hidden rather than shown and made to error.
  capabilities: ["projects", "deployments", "buildLogs", "env", "domains"],
  actions: [...CLOUDFLARE_ACTIONS],
  productionAffecting: [...PRODUCTION_AFFECTING_ACTIONS],
};

/**
 * No `linkFile`: Wrangler records a project's *name* in `wrangler.toml` /
 * `wrangler.jsonc`, neither of which is JSON, and neither of which is written
 * by a link command the way `.vercel/project.json` is. That tier of the
 * resolution ladder is simply skipped, which is what it was built to allow.
 */
export const CLOUDFLARE_HOOKS: DeployProviderHooks = {
  repoUrl: cloudflareRepoUrl,
};

/**
 * The build settings Cloudflare exposes.
 *
 * The first three deliberately reuse Vercel's keys: they mean the same thing,
 * and a settings panel that keys on `buildCommand` should not have to learn a
 * second word for it. `productionBranch` has no Vercel equivalent as a setting.
 */
const CLOUDFLARE_SETTINGS: { key: keyof CloudflareProject & string; label: string }[] = [
  { key: "buildCommand", label: "Build command" },
  { key: "destinationDir", label: "Output directory" },
  { key: "rootDir", label: "Root directory" },
  { key: "productionBranch", label: "Production branch" },
];

/** The neutral keys those map onto, so the shared panel sees one vocabulary. */
const SETTING_KEYS: Record<string, string> = {
  buildCommand: "buildCommand",
  destinationDir: "outputDirectory",
  rootDir: "rootDirectory",
  productionBranch: "productionBranch",
};

/**
 * Cloudflare's (stage, status) pair onto the seven neutral states.
 *
 * A build is `success` at every stage it completes, so "succeeded" only means
 * "ready" once the stage reached is `deploy`; anything earlier is still in
 * flight. A skipped deployment — Cloudflare's own eighth outcome — has no
 * neutral equivalent, so it folds into `canceled` and survives in `rawState`,
 * which is exactly the pressure valve that state field was added for.
 */
export function toProviderState(deployment: CloudflareDeployment): ProviderDeploymentState {
  if (deployment.isSkipped) return "canceled";
  const { name, status } = deployment.stage;
  if (status === "failure") return "error";
  if (status === "canceled") return "canceled";
  if (status === "success") return name === "deploy" ? "ready" : "building";
  return name === "queued" ? "queued" : "building";
}

const rawState = (deployment: CloudflareDeployment): string =>
  deployment.isSkipped ? "skipped" : `${deployment.stage.name}:${deployment.stage.status}`;

export function toProviderProject(project: CloudflareProject): ProviderProject {
  const settings: ProviderSetting[] = [];
  for (const { key, label } of CLOUDFLARE_SETTINGS) {
    const value = project[key];
    // Cloudflare returns the same project shape from both endpoints, so unlike
    // Vercel nothing is ever "not read" — but the guard is kept so the two
    // adapters answer the absent case the same way.
    if (value === undefined) continue;
    settings.push({
      key: SETTING_KEYS[key] ?? key,
      label,
      value: typeof value === "string" ? value : null,
    });
  }
  return {
    // The name, not the UUID — see this module's header.
    id: project.name,
    name: project.name,
    framework: project.framework,
    updatedAt: project.updatedAt,
    link: project.source
      ? {
          type: project.source.type,
          org: project.source.owner,
          repo: project.source.repoName,
          productionBranch: project.source.productionBranch,
        }
      : undefined,
    settings,
  };
}

export function toProviderDeployment(
  deployment: CloudflareDeployment,
  context: { canonicalDeploymentId?: string; inspectorUrl?: string } = {},
): ProviderDeployment {
  return {
    id: deployment.id,
    name: deployment.projectName,
    url: deployment.url,
    state: toProviderState(deployment),
    rawState: rawState(deployment),
    // Cloudflare names both environments, where Vercel leaves a preview's
    // target null. The consumers test for `"production"`, so its own word is
    // kept rather than nulled to match Vercel's quirk.
    target: deployment.environment,
    createdAt: deployment.createdAt,
    readyAt: toProviderState(deployment) === "ready" ? deployment.modifiedAt : undefined,
    // Which deployment production serves lives on the project, because a
    // rollback moves it; the caller reads it once and passes it in.
    isCurrentProduction: context.canonicalDeploymentId
      ? deployment.id === context.canonicalDeploymentId
      : undefined,
    // Cloudflare records no author for a deployment, only the commit it came
    // from, so `creator` is absent rather than guessed at.
    meta: {
      branch: deployment.branch,
      sha: deployment.commitHash,
      commitMessage: deployment.commitMessage,
    },
    inspectorUrl: context.inspectorUrl,
  };
}

function toProviderDeploymentDetail(
  deployment: CloudflareDeployment,
  context: { canonicalDeploymentId?: string; inspectorUrl?: string },
): ProviderDeploymentDetail {
  return {
    ...toProviderDeployment(deployment, context),
    aliases: deployment.aliases,
    // Cloudflare reports a failure by the stage that failed, not with a message.
    errorMessage:
      toProviderState(deployment) === "error"
        ? `The ${deployment.stage.name} stage failed.`
        : undefined,
  };
}

function toBuildLogLine(line: CloudflareBuildLogLine): ProviderLogLine {
  return { id: line.id, createdAt: line.createdAt, kind: "build", level: "stdout", text: line.text };
}

export function toProviderEnvVar(env: CloudflareEnvVar): ProviderEnvVar {
  return {
    // Cloudflare has no variable ids — the key is how one is addressed.
    id: env.key,
    key: env.key,
    environments: env.environments,
    type: env.type === "plain_text" ? "plain" : "encrypted",
  };
}

export function toProviderDomain(domain: CloudflareDomain): ProviderDomain {
  const pending = domain.status !== "active" && domain.validation?.txtName;
  return {
    name: domain.name,
    verified: domain.status === "active",
    createdAt: domain.createdAt,
    verification: pending
      ? [
          {
            type: "TXT",
            domain: domain.validation?.txtName ?? domain.name,
            value: domain.validation?.txtValue ?? "",
            reason: domain.errorMessage ?? domain.status,
          },
        ]
      : [],
  };
}

/**
 * The read-safe half, over an already-authenticated `CloudflareManager`.
 *
 * `projectName` is the project the caller resolved for this repository, and is
 * what makes the project-scoped deployment endpoints reachable through a
 * contract whose deployment methods take only an id.
 */
export function createCloudflareDeployProvider(
  manager: CloudflareManager,
  projectName?: string,
): DeployProvider {
  const project = (): string => {
    if (!projectName) {
      throw new Error(
        "Cloudflare addresses deployments within a project. Link this repository to a Pages project first.",
      );
    }
    return projectName;
  };

  return {
    async account() {
      const user = await manager.viewer();
      return {
        id: user.id,
        username: user.username ?? user.email ?? "cloudflare",
        email: user.email ?? null,
      };
    },
    async listScopes() {
      return (await manager.listAccounts()).map((account) => ({
        id: account.id,
        // Cloudflare accounts have no slug; the id is what addresses one.
        slug: account.id,
        name: account.name,
      }));
    },
    async listProjects(opts) {
      return (await manager.listProjects(opts)).map(toProviderProject);
    },
    async getProject(id) {
      return toProviderProject(await manager.getProject(id));
    },
    async listDeployments(opts) {
      // One round trip, not two: the list and the project that says which
      // deployment production currently serves are fetched together.
      const [deployments, canonicalDeploymentId] = await Promise.all([
        manager.listDeployments({
          projectName: opts.projectId,
          env: opts.target,
          limit: opts.limit,
        }),
        manager.canonicalDeploymentId(opts.projectId).catch(() => undefined),
      ]);
      return deployments.map((deployment) =>
        toProviderDeployment(deployment, {
          canonicalDeploymentId,
          inspectorUrl: manager.inspectorUrl(opts.projectId, deployment.id),
        }),
      );
    },
    async getDeployment(id) {
      const projectName = project();
      const [deployment, canonicalDeploymentId] = await Promise.all([
        manager.getDeployment(projectName, id),
        manager.canonicalDeploymentId(projectName).catch(() => undefined),
      ]);
      return toProviderDeploymentDetail(deployment, {
        canonicalDeploymentId,
        inspectorUrl: manager.inspectorUrl(projectName, deployment.id),
      });
    },
    async buildLogs(id, limit) {
      return (await manager.deploymentBuildLogs(project(), id, limit)).map(toBuildLogLine);
    },
    async listEnv(projectId) {
      return (await manager.listEnv(projectId)).map(toProviderEnvVar);
    },
    async getEnvValue(projectId, envId) {
      return manager.getEnvValue(projectId, envId);
    },
    async listDomains(projectId) {
      return (await manager.listDomains(projectId)).map(toProviderDomain);
    },
  };
}

/**
 * The write-capable half. Kept a separate factory, resolved separately, and
 * never handed to an MCP tool — the same boundary `CloudflareActions` has.
 */
export function createCloudflareDeployActions(
  actions: CloudflareActions,
): DeployProviderActions {
  return {
    async run(action: string, input: DeployActionInput): Promise<DeployActionResult> {
      // Cloudflare addresses a deployment within its project, so every action
      // needs the project the route resolved — where Vercel needed the original
      // deployment's name and target instead.
      const projectName = requireField(input.projectId, "projectId");
      switch (action) {
        case "redeploy": {
          const created = await actions.retry(projectName, input.deploymentId);
          return { deployment: created };
        }
        case "rollback": {
          const rolled = await actions.rollback(projectName, input.deploymentId);
          return { deployment: rolled };
        }
        default:
          throw new Error(`Cloudflare does not support the action "${action}".`);
      }
    },

    async createEnv(projectId, input) {
      return toProviderEnvVar(
        await actions.createEnv(projectId, {
          key: input.key,
          value: input.value,
          environments: input.environments,
          secret: input.type !== "plain",
        }),
      );
    },
    async updateEnv(projectId, envId, input) {
      return toProviderEnvVar(await actions.updateEnv(projectId, envId, input));
    },
    async deleteEnv(projectId, envId) {
      await actions.deleteEnv(projectId, envId);
    },
  };
}

function requireField(value: string | undefined, field: string): string {
  if (!value) throw new Error(`This action requires "${field}".`);
  return value;
}
