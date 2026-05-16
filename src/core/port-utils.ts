import net from "node:net";

export interface PortStatus {
  port: number;
  available: boolean;
}

export async function isPortAvailable(
  port: number,
  host = "127.0.0.1",
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        resolve(false);
        return;
      }

      reject(error);
    });

    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function getPortStatus(port: number): Promise<PortStatus> {
  return {
    port,
    available: await isPortAvailable(port),
  };
}
