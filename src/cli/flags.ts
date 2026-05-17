export function parseFlags(args: string[]): Record<string, string | undefined> {
  const flags: Record<string, string | undefined> = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg?.startsWith("--")) {
      continue;
    }

    const [key, inlineValue] = arg.slice(2).split("=", 2);
    flags[toCamelCase(key)] = inlineValue ?? args[index + 1];
    if (!inlineValue) {
      index += 1;
    }
  }

  return flags;
}

function toCamelCase(input: string): string {
  return input.replace(/-([a-z])/g, (_match, letter: string) =>
    letter.toUpperCase(),
  );
}
