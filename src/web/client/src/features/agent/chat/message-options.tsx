import { ExternalLink, Play } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The agent talks to the dock through fenced blocks we strip out of the prose:
 *  - ```options …``` — one selectable choice per line (rendered as buttons).
 *  - ```service <name>``` — a service it just registered (rendered as start/open
 *    actions so the user can jump straight to it).
 * See the service-setup prompt for the wording the agent is told to use.
 */
const OPTIONS_BLOCK = /```options[^\n]*\n([\s\S]*?)```/g;
const SERVICE_BLOCK = /```service[^\n]*\n([\s\S]*?)```/g;
// A block still streaming in (no closing fence yet) — hide it until complete.
const DANGLING_BLOCK = /```(?:options|service)[^\n]*\n[\s\S]*$/;

export interface ParsedAgentMessage {
  body: string;
  options: string[];
  /** Name of a service the agent just registered, if it announced one. */
  service: string | null;
}

export function parseAgentMessage(text: string): ParsedAgentMessage {
  const options: string[] = [];
  let service: string | null = null;

  let body = text.replace(OPTIONS_BLOCK, (_match, inner: string) => {
    for (const line of inner.split("\n")) {
      const choice = line.replace(/^[-*\d.)\s]+/, "").trim();
      if (choice) options.push(choice);
    }
    return "";
  });
  body = body.replace(SERVICE_BLOCK, (_match, inner: string) => {
    const name = inner.split("\n").map((line) => line.trim()).find(Boolean);
    if (name) service = name;
    return "";
  });
  body = body.replace(DANGLING_BLOCK, "");
  return { body: body.trim(), options, service };
}

export function OptionList({
  options,
  disabled,
  onChoose,
}: {
  options: string[];
  disabled?: boolean;
  onChoose: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => (
        <Button
          className="h-7"
          disabled={disabled}
          key={option}
          onClick={() => onChoose(option)}
          size="sm"
          type="button"
          variant="outline"
        >
          {option}
        </Button>
      ))}
    </div>
  );
}

/** Start / open shortcuts for a service the agent just registered. */
export function ServiceActions({
  service,
  onStart,
  onOpen,
}: {
  service: string;
  onStart: (name: string) => void;
  onOpen?: (name: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2 py-1.5">
      <span className="text-[11px] text-muted-foreground">
        Added <span className="font-medium text-foreground">{service}</span>
      </span>
      <div className="ml-auto flex gap-1.5">
        <Button className="h-7" onClick={() => onStart(service)} size="sm" type="button">
          <Play /> Start
        </Button>
        {onOpen ? (
          <Button
            className="h-7"
            onClick={() => onOpen(service)}
            size="sm"
            type="button"
            variant="outline"
          >
            <ExternalLink /> Open
          </Button>
        ) : null}
      </div>
    </div>
  );
}
