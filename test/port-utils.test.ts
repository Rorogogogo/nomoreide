import net from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import {
  getPortBindingStatus,
  getPortStatus,
  isPortAvailable,
} from "../src/core/port-utils.js";

const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  servers.length = 0;
});

describe("port utilities", () => {
  test("reports a free port as available", async () => {
    const port = await findFreePort();

    await expect(isPortAvailable(port)).resolves.toBe(true);
  });

  test("reports a listening port as unavailable", async () => {
    const server = await listenOnFreePort();
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    await expect(isPortAvailable(port)).resolves.toBe(false);
    await expect(getPortStatus(port)).resolves.toEqual({
      port,
      available: false,
    });
  });

  test("detects a port bound on 127.0.0.1", async () => {
    const port = await listen("127.0.0.1");

    await expect(getPortBindingStatus(port)).resolves.toMatchObject({
      port,
      available: false,
    });
  });

  test("detects a port bound on IPv6 localhost", async () => {
    const port = await listen("::1");
    const status = await getPortBindingStatus(port);

    expect(status.available).toBe(false);
    expect(status.hosts.some((host) => host.host === "::1" && !host.available)).toBe(
      true,
    );
  });

  test("detects a port bound on all IPv4 interfaces", async () => {
    const port = await listen("0.0.0.0");
    const status = await getPortBindingStatus(port);

    expect(status.available).toBe(false);
    expect(
      status.hosts.some((host) => host.host === "0.0.0.0" && !host.available),
    ).toBe(true);
  });
});

async function listen(host: string): Promise<number> {
  const server = net.createServer();
  servers.push(server);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return address.port;
}

async function listenOnFreePort(): Promise<net.Server> {
  const server = net.createServer();
  servers.push(server);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  return server;
}

async function findFreePort(): Promise<number> {
  const server = await listenOnFreePort();
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  await new Promise<void>((resolve) => server.close(() => resolve()));
  servers.pop();

  return port;
}
