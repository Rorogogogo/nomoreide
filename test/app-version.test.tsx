import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AppIdentity } from "../src/web/client/src/app";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AppIdentity", () => {
  test("shows the package version with the local console label", () => {
    vi.stubGlobal("__APP_VERSION__", "0.1.5");

    const markup = renderToStaticMarkup(<AppIdentity />);

    expect(markup).toContain("NoMoreIDE");
    expect(markup).toContain("127.0.0.1 console");
    expect(markup).toContain("v0.1.5");
  });
});
