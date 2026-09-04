import { describe, expect, test } from "vitest";
import {
  pathInScope,
  serviceInScope,
  unassignedServices,
} from "../apps/dashboard/src/features/services/project-scope";
import type { ServiceDefinition } from "../apps/dashboard/src/lib/api";

const REPOS = [
  { name: "JobJourney", path: "/Users/dev/work/JJ/JobJourney" },
  { name: "nomoreide", path: "/Users/dev/work/nomoreide" },
];

function service(overrides: Partial<ServiceDefinition>): ServiceDefinition {
  return { name: "svc", command: "npm start", ...overrides } as ServiceDefinition;
}

describe("serviceInScope", () => {
  test("infers the project from cwd when unassigned", () => {
    const api = service({ cwd: "/Users/dev/work/JJ/JobJourney/server" });

    expect(serviceInScope(api, REPOS[0].path)).toBe(true);
    expect(serviceInScope(api, REPOS[1].path)).toBe(false);
  });

  test("places a remote service whose cwd is on another machine", () => {
    // The case inference cannot express: /var/www/... sits under no local repo.
    const remote = service({
      name: "jobjourney-prod-logs",
      cwd: "/var/www/jobjourney-server",
      projectPath: "/Users/dev/work/JJ/JobJourney",
    });

    expect(serviceInScope(remote, REPOS[0].path)).toBe(true);
    expect(unassignedServices([remote], REPOS)).toEqual([]);
  });

  test("an explicit assignment overrides a conflicting cwd", () => {
    // Otherwise pinning could never move a service that already inferred.
    const pinned = service({
      cwd: "/Users/dev/work/nomoreide/packages/api",
      projectPath: "/Users/dev/work/JJ/JobJourney",
    });

    expect(serviceInScope(pinned, REPOS[0].path)).toBe(true);
    expect(serviceInScope(pinned, REPOS[1].path)).toBe(false);
  });

  test("does not treat a sibling directory as inside the repo", () => {
    const sibling = service({ cwd: "/Users/dev/work/nomoreide-scratch" });

    expect(serviceInScope(sibling, "/Users/dev/work/nomoreide")).toBe(false);
  });

  test("matches the repo root itself", () => {
    expect(serviceInScope(service({ cwd: "/Users/dev/work/nomoreide" }), "/Users/dev/work/nomoreide")).toBe(true);
  });

  test("tolerates a trailing slash on the repo path", () => {
    expect(pathInScope("/Users/dev/work/nomoreide/src", "/Users/dev/work/nomoreide/")).toBe(true);
  });
});

describe("unassignedServices", () => {
  test("returns only services no project claims", () => {
    const services = [
      service({ name: "web", cwd: "/Users/dev/work/nomoreide" }),
      service({ name: "storefront-logs", cwd: "/root" }),
      service({ name: "portfolio", cwd: "/Users/dev/work/builder-island" }),
      service({ name: "pinned", cwd: "/root", projectPath: "/Users/dev/work/nomoreide" }),
    ];

    expect(unassignedServices(services, REPOS).map((entry) => entry.name)).toEqual([
      "storefront-logs",
      "portfolio",
    ]);
  });

  test("counts a service pinned to a project that no longer exists", () => {
    // Deleting a repo must not leave a service silently claiming membership.
    const orphan = service({ cwd: "/root", projectPath: "/Users/dev/work/deleted" });

    expect(unassignedServices([orphan], REPOS).map((entry) => entry.name)).toEqual(["svc"]);
  });
});
