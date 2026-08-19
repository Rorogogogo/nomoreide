import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { DockerUnavailable } from "../src/web/client/src/features/docker/docker-view";

describe("DockerUnavailable", () => {
  test("keeps diagnostics behind a disclosure and offers an explicit retry", () => {
    const markup = renderToStaticMarkup(
      <DockerUnavailable
        canStart
        error="Cannot connect to the Docker daemon"
        installUrl={undefined}
        onRetry={async () => undefined}
        onStart={async () => undefined}
      />,
    );

    expect(markup).toContain("Docker not found");
    expect(markup).toContain("Check again");
    expect(markup).toContain("Start Docker");
    expect(markup).toContain("<details");
    expect(markup).toContain("Technical details");
    expect(markup).toContain("Cannot connect to the Docker daemon");
  });

  test("offers installation instead of start when Docker Desktop is missing", () => {
    const markup = renderToStaticMarkup(
      <DockerUnavailable
        canStart={false}
        error="docker: command not found"
        installUrl="https://docs.docker.com/desktop/setup/install/mac-install/"
        onRetry={async () => undefined}
        onStart={async () => undefined}
      />,
    );

    expect(markup).toContain("Install Docker");
    expect(markup).not.toContain("Start Docker");
  });
});
