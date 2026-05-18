import net from "node:net";

export interface PortStatus {
  port: number;
  available: boolean;
}

export interface HostPortStatus {
  host: string;
  available: boolean;
  errorCode?: string;
}

export interface PortBindingStatus {
  port: number;
  available: boolean;
  hosts: HostPortStatus[];
}

export async function isPortAvailable(
  port: number,
  host = "127.0.0.1",
): Promise<boolean> {
  return (await checkHostPort(port, host)).available;
}

export async function getPortStatus(port: number): Promise<PortStatus> {
  const status = await getPortBindingStatus(port);
  return {
    port,
    available: status.available,
  };
}

export async function getPortBindingStatus(
  port: number,
): Promise<PortBindingStatus> {
  const hosts = ["127.0.0.1", "localhost", "::1", "0.0.0.0"];
  const statuses = await Promise.all(
    hosts.map(async (host) => ({
      host,
      ...(await checkHostPort(port, host)),
    })),
  );

  return {
    port,
    available: statuses.every((status) => status.available),
    hosts: statuses,
  };
}

async function checkHostPort(
  port: number,
  host: string,
): Promise<{ available: boolean; errorCode?: string }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        resolve({ available: false, errorCode: error.code });
        return;
      }

      reject(error);
    });

    server.listen(port, host, () => {
      server.close(() => resolve({ available: true }));
    });
  });
}
