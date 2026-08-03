import type { ConfigStore } from "../core/config-store.js";
import { DbPeek } from "../core/db-peek.js";
import type { DatabaseEngine } from "../core/types.js";
import { UsageError } from "./errors.js";
import { parseFlags } from "./flags.js";

const USAGE = [
  "Usage: nomoreide db <command>",
  "  list",
  "  add <name> --engine <postgres|mysql|sqlite> --url <url> [--project-path <path>] [--replace] [--no-check]",
  "  check <connection>",
  "  remove <connection>",
  "  schemas <connection>",
  "  objects <connection> --schema <schema>",
  "  describe <connection> --key <opaque-key>",
  "  script <connection> --key <opaque-key>",
  "  sample <connection> <table> [--limit <rows>] [--offset <rows>]",
  "  query <connection> --sql <select> [--limit <rows>]",
].join("\n");

const ENGINES = new Set<DatabaseEngine>(["postgres", "mysql", "sqlite"]);
const VALUE_FLAGS = new Set([
  "--engine",
  "--url",
  "--project-path",
  "--schema",
  "--key",
  "--limit",
  "--offset",
  "--sql",
]);

export async function runDatabaseCli(
  subcommand: string | undefined,
  args: string[],
  stdout: (line: string) => void,
  configStore: ConfigStore,
): Promise<number> {
  const dbPeek = new DbPeek({ configStore });
  const flags = parseFlags(args);
  const positional = positionalArgs(args);
  const connection = positional[0];

  try {
    if (subcommand === "list") {
      stdout(JSON.stringify(await dbPeek.listConnections(), null, 2));
      return 0;
    }

    if (subcommand === "add") {
      const name = required(connection, "connection name");
      const engine = required(flags.engine, "--engine") as DatabaseEngine;
      if (!ENGINES.has(engine)) {
        throw new UsageError("--engine must be one of: postgres, mysql, sqlite");
      }
      const result = await dbPeek.register({
        name,
        engine,
        url: required(flags.url, "--url"),
        projectPath: flags.projectPath,
        replace: args.includes("--replace"),
        check: !args.includes("--no-check"),
      });
      stdout(JSON.stringify(result, null, 2));
      return 0;
    }

    if (subcommand === "check") {
      stdout(JSON.stringify(await dbPeek.check(required(connection, "connection")), null, 2));
      return 0;
    }

    if (subcommand === "remove") {
      const name = required(connection, "connection");
      await configStore.removeDatabase(name);
      stdout(`Removed database connection ${name}`);
      return 0;
    }

    if (subcommand === "schemas") {
      const name = required(connection, "connection");
      stdout(JSON.stringify({
        schemas: await dbPeek.listSchemas(name),
        capabilities: await dbPeek.capabilities(name),
      }, null, 2));
      return 0;
    }

    if (subcommand === "objects") {
      stdout(JSON.stringify(
        await dbPeek.listObjects(
          required(connection, "connection"),
          required(flags.schema, "--schema"),
        ),
        null,
        2,
      ));
      return 0;
    }

    if (subcommand === "describe" || subcommand === "script") {
      const details = await dbPeek.objectDetails(
        required(connection, "connection"),
        required(flags.key, "--key"),
      );
      if (subcommand === "script") {
        if (!details.createScript) {
          throw new Error("No create script is available for this database object.");
        }
        stdout(details.createScript);
      } else {
        stdout(JSON.stringify(details, null, 2));
      }
      return 0;
    }

    if (subcommand === "sample") {
      const result = await dbPeek.sampleRows(
        required(connection, "connection"),
        required(positional[1], "table"),
        positiveInteger(flags.limit, "--limit", 100),
        nonNegativeInteger(flags.offset, "--offset", 0),
      );
      stdout(JSON.stringify(result, null, 2));
      return 0;
    }

    if (subcommand === "query") {
      const result = await dbPeek.runQuery(
        required(connection, "connection"),
        required(flags.sql, "--sql"),
        positiveInteger(flags.limit, "--limit", 100),
      );
      stdout(JSON.stringify(result, null, 2));
      return 0;
    }

    throw new UsageError(USAGE);
  } finally {
    await dbPeek.closeAll();
  }
}

function positionalArgs(args: string[]): string[] {
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const flag = argument.split("=", 1)[0];
    if (!argument.includes("=") && VALUE_FLAGS.has(flag ?? "")) index += 1;
  }
  return positional;
}

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new UsageError(`${label} is required`);
  return value;
}

function positiveInteger(
  value: string | undefined,
  label: string,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`${label} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(
  value: string | undefined,
  label: string,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new UsageError(`${label} must be a non-negative integer`);
  }
  return parsed;
}
