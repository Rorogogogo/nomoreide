import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ServiceForm } from "../apps/dashboard/src/features/services/service-form/service-form";
import { OperationProvider } from "../apps/dashboard/src/components/operations/operation-context";
import type { ServiceDefinition } from "../apps/dashboard/src/lib/api";

describe("ServiceForm edit mode", () => {
  test("prefills fields from the existing service config", () => {
    const service: ServiceDefinition = {
      name: "backend",
      kind: "local",
      command: "npm run dev",
      cwd: "/repo/api",
      port: 4000,
      description: "API server",
    };

    const markup = renderToStaticMarkup(
      <OperationProvider>
        <ServiceForm cwd="/repo" initialService={service} onRefresh={async () => undefined} />
      </OperationProvider>,
    );

    expect(markup).toContain('value="backend"');
    expect(markup).toContain('value="npm run dev"');
    expect(markup).toContain('value="/repo/api"');
    expect(markup).toContain('value="4000"');
    expect(markup).toContain('value="API server"');
    // Edit mode: name is locked and the submit button reads "Save Service".
    expect(markup).toContain("readOnly");
    expect(markup).toContain("Save Service");
  });

  test("starts blank when creating a new service", () => {
    const markup = renderToStaticMarkup(
      <OperationProvider>
        <ServiceForm cwd="/repo" onRefresh={async () => undefined} />
      </OperationProvider>,
    );

    expect(markup).toContain("Add Service");
    expect(markup).not.toContain("Save Service");
    // Working directory defaults to the project cwd.
    expect(markup).toContain('value="/repo"');
  });

  test("renders direct arguments as separate fields", () => {
    const service: ServiceDefinition = {
      name: "worker",
      kind: "local",
      command: "/usr/bin/node",
      args: ["worker.js", "value with spaces"],
      cwd: "/repo",
    };

    const markup = renderToStaticMarkup(
      <OperationProvider>
        <ServiceForm cwd="/repo" initialService={service} onRefresh={async () => undefined} />
      </OperationProvider>,
    );

    expect(markup).toContain("Executable + arguments");
    expect(markup).toContain('aria-label="Execution mode"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('value="worker.js"');
    expect(markup).toContain('value="value with spaces"');
  });
});
