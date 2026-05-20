import { describe, expect, test } from "vitest";
import {
  createDockerComposeCommands,
  parseDockerPsOutput,
} from "../src/core/docker-service-runner.js";

describe("createDockerComposeCommands", () => {
  test("builds start, stop, status, and logs commands with compose file", () => {
    const commands = createDockerComposeCommands({
      cwd: "/repo",
      composeFile: "docker-compose.yml",
      composeService: "api",
    });

    expect(commands.start).toEqual([
      "docker",
      ["compose", "-f", "docker-compose.yml", "up", "-d", "api"],
    ]);
    expect(commands.stop).toEqual([
      "docker",
      ["compose", "-f", "docker-compose.yml", "stop", "api"],
    ]);
    expect(commands.status).toEqual([
      "docker",
      ["compose", "-f", "docker-compose.yml", "ps", "--format", "json", "api"],
    ]);
    expect(commands.logs).toEqual([
      "docker",
      ["compose", "-f", "docker-compose.yml", "logs", "--tail", "120", "api"],
    ]);
  });

  test("omits -f when no compose file is provided", () => {
    const commands = createDockerComposeCommands({
      cwd: "/repo",
      composeService: "api",
    });
    expect(commands.start).toEqual(["docker", ["compose", "up", "-d", "api"]]);
  });

  test("validates composeService and cwd", () => {
    expect(() =>
      createDockerComposeCommands({ cwd: "/repo", composeService: " " }),
    ).toThrow(/service name/);
    expect(() =>
      createDockerComposeCommands({ cwd: "", composeService: "api" }),
    ).toThrow(/cwd/);
  });
});

describe("parseDockerPsOutput", () => {
  test("parses container id and state from docker compose ps json", () => {
    const output = `{"ID":"abc123","Name":"repo-api-1","State":"running"}\n`;
    expect(parseDockerPsOutput(output)).toEqual({
      containerId: "abc123",
      state: "running",
    });
  });

  test("returns empty object when no container is reported", () => {
    expect(parseDockerPsOutput("\n")).toEqual({});
  });
});
