import { exec } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface PortHolder {
  pid: number;
  pgid?: number;
  command: string;
}

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

export async function getPortHolder(port: number): Promise<PortHolder | null> {
  try {
    const { stdout } = await execAsync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, {
      timeout: 1500,
    });
    const pid = Number(stdout.trim().split(/\s+/)[0]);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return {
      pid,
      pgid: await readPgid(pid),
      command: await readCommand(pid),
    };
  } catch {
    return null;
  }
}

async function readPgid(pid: number): Promise<number | undefined> {
  try {
    const { stdout } = await execAsync(`ps -o pgid= -p ${pid}`, {
      timeout: 1000,
    });
    const pgid = Number(stdout.trim());
    return Number.isFinite(pgid) && pgid > 0 ? pgid : undefined;
  } catch {
    return undefined;
  }
}

async function readCommand(pid: number): Promise<string> {
  try {
    const { stdout } = await execAsync(`ps -o command= -p ${pid}`, {
      timeout: 1000,
    });
    return stdout.trim().split("\n")[0] || `pid ${pid}`;
  } catch {
    return `pid ${pid}`;
  }
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
