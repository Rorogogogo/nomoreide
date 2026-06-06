import { Database, ExternalLink, Play } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The agent talks to the dock through fenced blocks we strip out of the prose:
 *  - ```options …``` — one selectable choice per line (rendered as buttons).
 *  - ```service <name>``` — a service it just registered (rendered as start/open
 *    actions so the user can jump straight to it).
 *  - ```sql-write <connection>``` — a write it can't run itself (its DB tools are
 *    read-only); rendered as an "Open in SQL console" button that stages the
 *    statement in the human-only write console. See the database prompts'
 *    {@link writeStagingNote} for the wording the agent is told to use.
 * See the service-setup prompt for the wording the agent is told to use.
 */
const OPTIONS_BLOCK = /```options[^\n]*\n([\s\S]*?)```/g;
const SERVICE_BLOCK = /```service[^\n]*\n([\s\S]*?)```/g;
const SQL_WRITE_BLOCK = /```sql-write[^\S\n]*([^\n]*)\n([\s\S]*?)```/g;
// A block still streaming in (no closing fence yet) — hide it until complete.
const DANGLING_BLOCK = /```(?:options|service|sql-write)[^\n]*\n[\s\S]*$/;

/** A write the agent drafted for the human-only SQL console. */
export interface SqlWriteProposal {
  /** Target connection name, as echoed by the agent (may be ""). */
  connection: string;
  /** The single statement to stage in the console editor. */
  sql: string;
}

export interface ParsedAgentMessage {
  body: string;
  options: string[];
  /** Name of a service the agent just registered, if it announced one. */
  service: string | null;
  /** A write statement the agent staged for the SQL console, if any. */
  sqlWrite: SqlWriteProposal | null;
}

export function parseAgentMessage(text: string): ParsedAgentMessage {
  const options: string[] = [];
  let service: string | null = null;
  let sqlWrite: SqlWriteProposal | null = null;

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
  body = body.replace(SQL_WRITE_BLOCK, (_match, connection: string, inner: string) => {
    const sql = inner.trim();
    // Last write wins, and only keep one with an actual statement.
    if (sql) sqlWrite = { connection: connection.trim(), sql };
    return "";
  });
  body = body.replace(DANGLING_BLOCK, "");
  return { body: body.trim(), options, service, sqlWrite };
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

/**
 * "Open in SQL console" affordance for a write the agent drafted but can't run.
 * Clicking stages the statement in the human-only console — the user still
 * unlocks writes and reviews the affected-rows preview before it commits.
 */
export function SqlWriteAction({
  proposal,
  onOpen,
}: {
  proposal: SqlWriteProposal;
  onOpen: (connection: string, sql: string) => void;
}) {
  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Database className="size-3.5 text-amber-600 dark:text-amber-400" />
        <span>
          Proposed write
          {proposal.connection ? (
            <>
              {" "}
              on <span className="font-medium text-foreground">{proposal.connection}</span>
            </>
          ) : null}{" "}
          — runs in the console after you unlock and preview.
        </span>
      </div>
      <pre className="mb-2 max-h-28 overflow-auto rounded bg-background px-2 py-1.5 font-mono text-[11px] text-foreground">
        {proposal.sql}
      </pre>
      <Button
        className="h-7 w-full bg-amber-600 text-white hover:bg-amber-600/90"
        onClick={() => onOpen(proposal.connection, proposal.sql)}
        size="sm"
        type="button"
      >
        <ExternalLink /> Open in SQL console
      </Button>
    </div>
  );
}
