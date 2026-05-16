import net from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { getPortStatus, isPortAvailable } from "../src/core/port-utils.js";

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
});

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
