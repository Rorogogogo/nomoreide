import { parse as parseToml } from "smol-toml";
import type { AgentEnvSettings } from "@/lib/api";

export interface AgentSettingsValidation {
  valid: boolean;
  error: string | null;
}

/** Browser-side parse check. The server repeats this check before every write. */
export function validateAgentSettingsContent(
  content: string,
  format: AgentEnvSettings["format"],
): AgentSettingsValidation {
  try {
    const parsed = format === "json" ? JSON.parse(content) : parseToml(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("top-level value must be an object");
    }
    return { valid: true, error: null };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Parse first, then print a stable, readable representation. */
export function formatAgentSettingsContent(
  content: string,
  format: AgentEnvSettings["format"],
): string {
  const validation = validateAgentSettingsContent(content, format);
  if (!validation.valid) throw new Error(validation.error ?? "Invalid settings");
  const formatted = format === "json"
    ? JSON.stringify(JSON.parse(content), null, 2)
    : formatTomlPreservingComments(content);
  return formatted.endsWith("\n") ? formatted : `${formatted}\n`;
}

/** Conservative TOML whitespace formatting that retains comments and ordering. */
function formatTomlPreservingComments(content: string): string {
  return content.split(/\r?\n/).map((line) => {
    const trimmedEnd = line.trimEnd();
    const equals = unquotedEqualsIndex(trimmedEnd);
    if (equals < 0) return trimmedEnd;
    const indent = trimmedEnd.match(/^\s*/)?.[0] ?? "";
    const key = trimmedEnd.slice(indent.length, equals).trimEnd();
    const value = trimmedEnd.slice(equals + 1).trimStart();
    return `${indent}${key} = ${value}`;
  }).join("\n");
}

function unquotedEqualsIndex(line: string): number {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"' && character === "\\" && !escaped) {
      escaped = true;
      continue;
    }
    if ((character === '"' || character === "'") && !escaped) {
      quote = quote === character ? null : quote ?? character;
    } else if (character === "=" && quote === null) {
      return index;
    } else if (character === "#" && quote === null) {
      return -1;
    }
    escaped = false;
  }
  return -1;
}
