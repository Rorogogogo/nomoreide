import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  AppIdentity,
  SidebarCredit,
  sidebarShellClassName,
  navButtonClassName,
  navButtonIconClassName,
  navButtonLabelClassName,
} from "../src/web/client/src/app";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("application operation feedback", () => {
  test("keeps the provider above page content and mounts one strip in the shell", () => {
    const source = readFileSync(
      new URL("../src/web/client/src/app.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toMatch(
      /<OperationProvider>\s*<AppContent syncLocation=\{syncLocation\} \/>\s*<\/OperationProvider>/,
    );
    expect(source.match(/<OperationStrip \/>/g)).toHaveLength(1);
    expect(source.indexOf("<OperationStrip />")).toBeGreaterThan(
      source.indexOf("</header>"),
    );
    expect(source.indexOf("<OperationStrip />")).toBeLessThan(
      source.indexOf("<RunningStripe"),
    );
  });
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

describe("SidebarCredit", () => {
  test("shows the maker credit and LinkedIn link", () => {
    const markup = renderToStaticMarkup(<SidebarCredit docked />);

    expect(markup).toContain("Made with");
    expect(markup).toContain("love");
    expect(markup).toContain("by Robert Wang");
    expect(markup).toContain("https://www.linkedin.com/in/robert-wang-cs/");
    expect(markup).toContain("LinkedIn");
    expect(markup).toContain("h-10");
    expect(markup).toContain("text-[11px]");
    expect(markup).toContain("shrink-0");
    expect(markup).toContain("text-red-500");
    expect(markup).toContain("viewBox=\"0 0 24 24\"");
    expect(markup).toContain("Undock sidebar");
    expect(markup).not.toContain("Docked");
    expect(markup).not.toContain(">Dock<");
    expect(markup).not.toContain("grid-cols-[48px_minmax(0,1fr)]");
  });

  test("centers the dock icon in collapsed mode", () => {
    const markup = renderToStaticMarkup(<SidebarCredit docked={false} />);

    expect(markup).toContain("w-12");
    expect(markup).toContain("justify-center");
    expect(markup).toContain("w-0");
    expect(markup).toContain("Dock sidebar");
    expect(markup).not.toContain("flex-1 opacity-0");
  });
});

describe("sidebar styling", () => {
  test("keeps the NoMoreIDE card style while using a hover-expanded rail", () => {
    expect(sidebarShellClassName()).toContain("w-16");
    expect(sidebarShellClassName()).toContain("hover:w-64");
    expect(sidebarShellClassName()).toContain("px-2");
    expect(sidebarShellClassName()).toContain("hover:px-4");
    expect(sidebarShellClassName()).toContain("bg-card/85");
    expect(sidebarShellClassName()).toContain("backdrop-blur");
    expect(sidebarShellClassName()).toContain("group/sidebar");
    expect(sidebarShellClassName()).toContain("transition-[width,padding]");
  });

  test("uses one stable grid layout while expanding nav rows to prevent hover bumping", () => {
    const active = navButtonClassName(true);
    const inactive = navButtonClassName(false);

    expect(active).toContain("w-12");
    expect(active).toContain("h-10");
    expect(active).toContain("grid");
    expect(active).toContain("grid-cols-[48px_minmax(0,1fr)]");
    expect(active).toContain("gap-0");
    expect(active).toContain("justify-start");
    expect(active).toContain("group-hover/sidebar:w-full");
    expect(active).not.toContain("flex");
    expect(active).not.toContain("group-hover/sidebar:grid");
    expect(active).toContain("text-sm");
    expect(active).toContain("bg-primary");
    expect(active).toContain("text-primary-foreground");
    expect(navButtonIconClassName(false)).toContain("-translate-x-px");
    expect(navButtonIconClassName(false)).toContain("group-hover/sidebar:translate-x-0");
    expect(navButtonIconClassName(true)).not.toContain("-translate-x-px");
    expect(inactive).toContain("hover:bg-muted");
    expect(inactive).not.toContain("text-muted-foreground");
  });

  test("supports docked mode that stays expanded without hover", () => {
    expect(sidebarShellClassName(true)).toContain("w-64");
    expect(sidebarShellClassName(true)).toContain("px-4");
    expect(sidebarShellClassName(true)).not.toContain("hover:w-64");
    expect(navButtonClassName(true, true)).toContain("w-full");
    expect(navButtonClassName(true, true)).not.toContain("w-12");
    expect(navButtonLabelClassName(true)).toContain("opacity-100");
    expect(navButtonLabelClassName(true).split(" ")).not.toContain("hidden");
    expect(navButtonLabelClassName(true).split(" ")).not.toContain("block");
    expect(navButtonLabelClassName(false).split(" ")).not.toContain("hidden");
    expect(navButtonLabelClassName(false).split(" ")).not.toContain("block");
  });
});
