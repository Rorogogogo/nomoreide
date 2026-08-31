// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ServersView } from "../apps/dashboard/src/features/servers/servers-view";

const api = vi.hoisted(() => ({
  getSshSetupStatus: vi.fn(),
  listSshServers: vi.fn(),
  openSshSetupTerminal: vi.fn(),
  probeSshServer: vi.fn(),
  saveSshServer: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  getSshSetupStatus: api.getSshSetupStatus,
  listSshServers: api.listSshServers,
  openSshSetupTerminal: api.openSshSetupTerminal,
  openSshTerminal: vi.fn(),
  probeSshServer: api.probeSshServer,
  removeSshServer: vi.fn(),
  saveSshServer: api.saveSshServer,
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  api.listSshServers.mockReset().mockResolvedValue([
    { host: "prod", name: "Production", discovered: false, saved: true },
  ]);
  api.probeSshServer.mockReset();
  api.getSshSetupStatus.mockReset().mockResolvedValue({
    publicKeys: ["id_ed25519.pub"],
    sshCopyIdAvailable: true,
  });
  api.openSshSetupTerminal.mockReset().mockResolvedValue({ id: "ssh-setup" });
  api.saveSshServer.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("SSH server refresh", () => {
  test("asks for a destination and username without storing a password", async () => {
    api.listSshServers.mockResolvedValue([]);
    api.probeSshServer.mockResolvedValue({
      host: "deploy@192.168.1.20",
      reachable: true,
      latencyMs: 12,
    });
    const onOpenTerminal = vi.fn();
    await act(async () => root.render(
      <ServersView onOpenActivity={() => undefined} onOpenTerminal={onOpenTerminal} />,
    ));
    await act(async () => Promise.resolve());

    const addButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Add SSH host"));
    await act(async () => addButton?.click());

    expect(container.textContent).toContain("Host alias, hostname, or IP");
    expect(container.textContent).toContain("Username");
    expect(container.textContent).toContain("password authentication is prompted only");
    const hostInput = container.querySelector<HTMLInputElement>("#server-host");
    const usernameInput = container.querySelector<HTMLInputElement>("#server-username");
    expect(usernameInput).not.toBeNull();
    expect(container.querySelector('input[type="password"]')).toBeNull();

    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      valueSetter?.call(hostInput, "192.168.1.20");
      hostInput?.dispatchEvent(new InputEvent("input", { bubbles: true }));
      valueSetter?.call(usernameInput, "deploy");
      usernameInput?.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });

    await act(async () => Promise.resolve());

    expect(container.textContent).toContain("SSH access setup");
    expect([...container.querySelectorAll("button")]
      .some((button) => button.textContent?.includes("Hide setup"))).toBe(true);
    expect(container.textContent).toContain("Public keys · 1");
    const testButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Test key access"));
    await act(async () => {
      testButton?.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Key authentication works");

    const installButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Install public key"));
    await act(async () => {
      installButton?.click();
      await Promise.resolve();
    });
    expect(api.openSshSetupTerminal).toHaveBeenCalledWith(
      "install-key",
      "deploy@192.168.1.20",
    );
    expect(onOpenTerminal).toHaveBeenCalledTimes(1);

    await act(async () => {
      container.querySelector("form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    expect(api.saveSshServer).toHaveBeenCalledWith({
      host: "deploy@192.168.1.20",
      name: undefined,
      environment: undefined,
    });
  });

  test("explains host context and includes probe platform details", async () => {
    api.listSshServers.mockResolvedValue([
      { host: "prod", name: "Production", discovered: true, saved: false },
    ]);
    api.probeSshServer.mockResolvedValue({
      host: "prod",
      reachable: true,
      hostname: "prod-web-01",
      platform: "Linux",
      latencyMs: 18,
    });

    const onOpenActivity = vi.fn();
    await act(async () => root.render(
      <ServersView onOpenActivity={onOpenActivity} onOpenTerminal={() => undefined} />,
    ));
    await act(async () => Promise.resolve());

    expect(container.textContent).toContain("SSH Servers");
    expect(container.textContent).toContain("No environment");
    expect(container.textContent).toContain("SSH config");
    expect(container.textContent).toContain("prod-web-01 · Linux · 18 ms");
    const activityButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="View activity"]',
    );
    await act(async () => activityButton?.click());
    expect(onOpenActivity).toHaveBeenCalledWith("prod");
  });

  test("probes every 30 seconds and does not overlap a slow host probe", async () => {
    let finishProbe: ((value: unknown) => void) | undefined;
    api.probeSshServer.mockImplementation(
      () => new Promise((resolve) => { finishProbe = resolve; }),
    );

    await act(async () => root.render(
      <ServersView onOpenActivity={() => undefined} onOpenTerminal={() => undefined} />,
    ));
    await act(async () => Promise.resolve());

    expect(api.listSshServers).toHaveBeenCalledTimes(1);
    expect(api.probeSshServer).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(api.listSshServers).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(25_000));
    expect(api.listSshServers).toHaveBeenCalledTimes(2);
    expect(api.probeSshServer).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishProbe?.({ host: "prod", reachable: true, latencyMs: 12 });
      await Promise.resolve();
    });
    api.probeSshServer.mockResolvedValue({ host: "prod", reachable: true, latencyMs: 10 });

    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(api.listSshServers).toHaveBeenCalledTimes(3);
    expect(api.probeSshServer).toHaveBeenCalledTimes(2);
  });
});
