import { describe, expect, test, vi } from "vitest";
import {
  createVercelDeployActions,
  createVercelDeployProvider,
  toProviderDeployment,
  toProviderEnvVar,
  toProviderProject,
  VERCEL_HOOKS,
  VERCEL_MANIFEST,
} from "../src/core/vercel-provider.js";
import type { VercelActions } from "../src/core/vercel-actions.js";
import type {
  VercelDeployment,
  VercelDeploymentState,
  VercelManager,
  VercelProject,
} from "../src/core/vercel-manager.js";

/**
 * Vercel driven through the `DeployProvider` contract. These assert the four
 * neutralizations hold — if any of them silently reverts to a Vercel shape,
 * provider #2 pays for it rather than a test failing here.
 */

const deployment = (overrides: Partial<VercelDeployment> = {}): VercelDeployment => ({
  uid: "dpl_1",
  name: "web",
  url: "web-abc.vercel.app",
  state: "READY",
  target: "production",
  createdAt: 1_000,
  meta: {},
  ...overrides,
});

describe("project settings become a list without losing null-vs-absent", () => {
  test("null survives as a value, because it means 'framework default'", () => {
    const project: VercelProject = {
      id: "prj_1",
      name: "web",
      buildCommand: null,
      installCommand: "npm ci",
    };

    const settings = toProviderProject(project).settings;

    expect(settings).toEqual([
      { key: "buildCommand", label: "Build command", value: null },
      { key: "installCommand", label: "Install command", value: "npm ci" },
    ]);
  });

  test("a setting the list endpoint never returned is absent, not null", () => {
    // Vercel's list endpoint omits what its single-project endpoint fills in.
    // Collapsing "not read" into "not overridden" would make the settings panel
    // claim every project uses framework defaults.
    const settings = toProviderProject({ id: "prj_1", name: "web" }).settings;

    expect(settings).toEqual([]);
    expect(settings.some((setting) => setting.key === "buildCommand")).toBe(false);
  });
});

describe("deployment state normalizes but never loses the vendor's word", () => {
  test.each<[VercelDeploymentState, string]>([
    ["QUEUED", "queued"],
    ["INITIALIZING", "building"],
    ["BUILDING", "building"],
    ["READY", "ready"],
    ["ERROR", "error"],
    ["CANCELED", "canceled"],
    ["BLOCKED", "blocked"],
    ["DELETED", "deleted"],
  ])("%s maps to %s", (raw, expected) => {
    const mapped = toProviderDeployment(deployment({ state: raw }));

    expect(mapped.state).toBe(expected);
    // The pressure valve: INITIALIZING and BUILDING share a neutral state, so
    // rawState is the only thing that can still tell them apart.
    expect(mapped.rawState).toBe(raw);
  });

  test("an unmapped state falls back rather than throwing", () => {
    const mapped = toProviderDeployment(
      deployment({ state: "SOMETHING_NEW" as VercelDeploymentState }),
    );

    expect(mapped.state).toBe("queued");
    expect(mapped.rawState).toBe("SOMETHING_NEW");
  });

  test("uid becomes the neutral id", () => {
    expect(toProviderDeployment(deployment()).id).toBe("dpl_1");
  });
});

describe("env vars", () => {
  test("target becomes environments, and the value is still absent", () => {
    const env = toProviderEnvVar({
      id: "env_1",
      key: "DATABASE_URL",
      target: ["production", "preview"],
      type: "encrypted",
    });

    expect(env.environments).toEqual(["production", "preview"]);
    expect(env).not.toHaveProperty("value");
    expect(env).not.toHaveProperty("target");
  });
});

describe("log lines merge into one shape", () => {
  test("build and runtime lines differ only by kind, level and request", async () => {
    const manager = {
      deploymentBuildLogs: vi.fn(async () => [
        { id: "b1", createdAt: 1, type: "stderr", text: "build failed" },
      ]),
      deploymentRuntimeLogs: vi.fn(async () => [
        {
          id: "r1",
          createdAt: 2,
          level: "error",
          message: "500 on /api",
          statusCode: 500,
          requestMethod: "GET",
          requestPath: "/api",
        },
      ]),
    } as unknown as VercelManager;
    const provider = createVercelDeployProvider(manager);

    expect(await provider.buildLogs("dpl_1")).toEqual([
      { id: "b1", createdAt: 1, kind: "build", level: "stderr", text: "build failed" },
    ]);
    expect(await provider.runtimeLogs?.("dpl_1")).toEqual([
      {
        id: "r1",
        createdAt: 2,
        kind: "runtime",
        level: "error",
        text: "500 on /api",
        source: undefined,
        request: { method: "GET", statusCode: 500, path: "/api" },
      },
    ]);
  });

  test("a runtime line with no request attached omits it entirely", async () => {
    const manager = {
      deploymentRuntimeLogs: vi.fn(async () => [
        { id: "r1", createdAt: 2, level: "info", message: "cold start" },
      ]),
    } as unknown as VercelManager;

    const [line] = (await createVercelDeployProvider(manager).runtimeLogs?.("dpl_1")) ?? [];
    expect(line.request).toBeUndefined();
  });
});

describe("actions are a named list, not fixed methods", () => {
  const stub = () => ({
    redeploy: vi.fn(async () => ({ uid: "dpl_2", url: "new.vercel.app" })),
    cancel: vi.fn(async () => undefined),
    promote: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
  });

  test("the manifest declares exactly what run() accepts", () => {
    expect(VERCEL_MANIFEST.actions).toEqual(["redeploy", "cancel", "promote", "rollback"]);
    expect(VERCEL_MANIFEST.productionAffecting).toEqual(["promote", "rollback"]);
    // Every production-affecting action must be a real action, or the UI would
    // confirm before something that cannot be run.
    for (const action of VERCEL_MANIFEST.productionAffecting) {
      expect(VERCEL_MANIFEST.actions).toContain(action);
    }
  });

  test("redeploy carries the original's target through", async () => {
    const actions = stub();

    const result = await createVercelDeployActions(
      actions as unknown as VercelActions,
    ).run("redeploy", { deploymentId: "dpl_1", name: "web", target: "production" });

    expect(actions.redeploy).toHaveBeenCalledWith({
      uid: "dpl_1",
      name: "web",
      target: "production",
    });
    expect(result.deployment).toEqual({ id: "dpl_2", url: "new.vercel.app" });
  });

  test("rollback passes its reason, promote has none to pass", async () => {
    const actions = stub();
    const run = createVercelDeployActions(actions as unknown as VercelActions);

    await run.run("rollback", {
      deploymentId: "dpl_1",
      projectId: "prj_1",
      description: "Rolled back from NoMoreIDE",
    });
    await run.run("promote", { deploymentId: "dpl_1", projectId: "prj_1" });

    expect(actions.rollback).toHaveBeenCalledWith("prj_1", "dpl_1", "Rolled back from NoMoreIDE");
    expect(actions.promote).toHaveBeenCalledWith("prj_1", "dpl_1");
  });

  test("an action the provider does not offer is refused by name", async () => {
    const run = createVercelDeployActions(stub() as unknown as VercelActions);

    await expect(run.run("publish", { deploymentId: "dpl_1" })).rejects.toThrow(
      'Vercel does not support the action "publish".',
    );
  });

  test("an action missing the field it needs says which one", async () => {
    const run = createVercelDeployActions(stub() as unknown as VercelActions);

    await expect(run.run("promote", { deploymentId: "dpl_1" })).rejects.toThrow(
      'This action requires "projectId".',
    );
  });

  test("createEnv speaks environments, VercelActions still speaks target", async () => {
    const actions = {
      createEnv: vi.fn(async () => ({
        id: "env_1",
        key: "K",
        target: ["production"],
        type: "encrypted",
      })),
    };

    const env = await createVercelDeployActions(
      actions as unknown as VercelActions,
    ).createEnv?.("prj_1", { key: "K", value: "v", environments: ["production"] });

    expect(actions.createEnv).toHaveBeenCalledWith("prj_1", {
      key: "K",
      value: "v",
      target: ["production"],
      type: undefined,
    });
    expect(env?.environments).toEqual(["production"]);
  });
});

describe("hooks", () => {
  test("the link file is the one the Vercel CLI writes", () => {
    expect(VERCEL_HOOKS.linkFile).toEqual({
      path: ".vercel/project.json",
      field: "projectId",
    });
  });

  test("repoUrl normalizes an ssh remote the way Vercel keys imports", () => {
    expect(VERCEL_HOOKS.repoUrl("git@github.com:acme/web.git")).toBe(
      "https://github.com/acme/web",
    );
    expect(VERCEL_HOOKS.repoUrl("./not-a-remote")).toBeNull();
  });
});
