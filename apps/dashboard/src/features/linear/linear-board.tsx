import { useState } from "react";
import { cn } from "@/lib/utils";
import { orderStates, priorityTone, stateTone } from "./linear-states";
import type { LinearIssue, LinearState } from "./linear-types";

/**
 * The board: one column per workflow state, drag a task between them.
 *
 * **Columns of rows, not a field of cards.** A Jira board is usually floating
 * tiles on a grey wash, which is the one thing DESIGN.md rules out — a section
 * of a page is not a floating object. So the columns are divided by hairlines
 * and each column is a `divide-y` stack of the same row the list view uses.
 * It reads as a board because the columns are labelled and the work moves
 * between them, not because anything is wearing a border.
 *
 * **Dragging is an accelerator, never the only way.** The detail pane keeps its
 * status control, so a state change is always reachable from the keyboard. A
 * board whose only affordance is a mouse gesture is a board half the people
 * using it cannot operate.
 */
export function LinearBoard({
  busy,
  issues,
  onMove,
  onSelect,
  selectedId,
  states,
  t,
}: {
  busy: boolean;
  issues: LinearIssue[];
  onMove: (id: string, state: LinearState) => void;
  onSelect: (id: string) => void;
  selectedId?: string;
  states: LinearState[];
  t: (key: string) => string;
}) {
  /** The column a card is hovering over, so the drop target is visible. */
  const [over, setOver] = useState<string | null>(null);
  const ordered = orderStates(states);

  if (ordered.length === 0) {
    return <p className="p-3 text-[12px] text-muted-foreground">{t("boardNoStates")}</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 divide-x divide-border overflow-x-auto">
      {ordered.map((state) => {
        const column = issues.filter((issue) => issue.state.id === state.id);
        return (
          <section
            // A `<section>` with an accessible name is a region, so the drop
            // handlers below sit on something assistive tech can announce
            // rather than on an anonymous box. The keyboard route to the same
            // change is the detail pane's status control — the drag is an
            // accelerator, never the only way.
            aria-label={state.name}
            className={cn(
              "flex w-64 shrink-0 flex-col transition-colors",
              over === state.id && "bg-muted/30",
            )}
            key={state.id}
            onDragLeave={() => setOver((current) => (current === state.id ? null : current))}
            onDragOver={(event) => {
              // Without this the browser refuses the drop outright.
              event.preventDefault();
              setOver(state.id);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setOver(null);
              const id = event.dataTransfer.getData("text/plain");
              // A drop back where it started is not a move. Skipping it saves
              // a mutation whose only effect would be a spinner.
              if (id && !column.some((issue) => issue.id === id)) onMove(id, state);
            }}
          >
            <div className="sticky top-0 flex items-center justify-between gap-2 border-b border-border bg-muted/20 px-3 py-1">
              <span className="flex min-w-0 items-center gap-1.5">
                <StateDot type={state.type} />
                <span className="truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {state.name}
                </span>
              </span>
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                {column.length}
              </span>
            </div>

            <div className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
              {column.map((issue) => (
                <button
                  className={cn(
                    "block w-full cursor-grab px-3 py-2 text-left transition-colors hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing",
                    selectedId === issue.id && "bg-muted/45",
                  )}
                  disabled={busy}
                  draggable={!busy}
                  key={issue.id}
                  onClick={() => onSelect(issue.id)}
                  onDragStart={(event) => {
                    event.dataTransfer.setData("text/plain", issue.id);
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  type="button"
                >
                  <span className="block truncate text-[13px] font-medium">{issue.title}</span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span className="font-mono">{issue.identifier}</span>
                    {issue.priority > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className={priorityTone(issue.priority)}>
                          {t(`priority${issue.priority}`)}
                        </span>
                      </>
                    )}
                    {issue.assignee && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="truncate">{issue.assignee.name}</span>
                      </>
                    )}
                  </span>
                </button>
              ))}
              {column.length === 0 && (
                <p className="px-3 py-2 text-[11px] text-muted-foreground">{t("boardEmpty")}</p>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** The status mark. `size-4` and `shrink-0`, as every status mark here is. */
function StateDot({ type }: { type: string }) {
  return (
    <span aria-hidden="true" className={cn("flex size-4 shrink-0 items-center justify-center", stateTone(type))}>
      <span className="size-1.5 rounded-full bg-current" />
    </span>
  );
}
