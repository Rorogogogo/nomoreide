import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import {
  columnFor as previewedColumn,
  orderStates,
  priorityTone,
  resolveColumn,
  stateTone,
  type BoardPreview,
} from "./linear-states";
import type { LinearIssue, LinearState } from "./linear-types";

/**
 * The board: one column per workflow state, drag a task between them.
 *
 * **Columns of rows, not a field of cards.** A Jira board is usually floating
 * tiles on a grey wash, which is the one thing DESIGN.md rules out — a section
 * of a page is not a floating object. So columns are divided by hairlines and
 * each is a `divide-y` stack of the row the list view uses. It reads as a board
 * because the columns are labelled and work moves between them.
 *
 * **The drag is dnd-kit, not the HTML5 drag API**, and that is the whole
 * difference in feel. The native API gives you a ghost image and a drop event
 * and nothing in between: cards do not move aside, nothing animates, and the
 * only feedback is a column tint. `SortableContext` transforms every sibling
 * out of the way as the pointer moves and transitions them back, so a gap opens
 * where the card would land and the rest glide around it. Same approach as the
 * JobJourney board this was modelled on.
 *
 * **Dragging is an accelerator, never the only way.** The detail view keeps a
 * status control, so every move is reachable from a keyboard. A board whose
 * only affordance is a pointer gesture is one that half its users cannot
 * operate.
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
  /** The card under the pointer, rendered in the overlay while it travels. */
  const [dragging, setDragging] = useState<LinearIssue | null>(null);
  /**
   * Where the dragged card is *pretending* to be, mid-drag.
   *
   * This is what opens the gap. `SortableContext` only moves siblings within
   * the list it is given, so hovering another column did nothing at all until
   * the card was actually a member of it — the target lane sat inert and the
   * space only appeared after the drop. Re-partitioning on this override makes
   * the card a member of the hovered column from the moment it is over it, so
   * the column's own sortable does the animating and the space is reserved
   * while you are still holding it.
   */
  const [preview, setPreview] = useState<BoardPreview>(null);
  const ordered = useMemo(() => orderStates(states), [states]);

  const columnFor = (issue: LinearIssue) => previewedColumn(issue, preview);

  /**
   * A drag starts only after 8px of movement.
   *
   * Without it every click on a card is also a drag of zero distance, and
   * opening a task by clicking it stops working — the pointer-down is captured
   * by the sensor and the click never lands.
   */
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  if (ordered.length === 0) {
    return <p className="p-3 text-[12px] text-muted-foreground">{t("boardNoStates")}</p>;
  }

  /** See `resolveColumn` — preview-aware, and a test says why. */
  const columnOf = (id: string) => resolveColumn(id, ordered, issues, preview);

  function onDragOver(event: DragOverEvent) {
    const moved = event.active.id as string;
    const over = event.over?.id as string | undefined;
    // Hovering yourself says nothing about where you are going, and resolving
    // it is the step that made the loop above possible at all.
    if (!over || over === moved) return;
    const target = columnOf(over);
    if (!target) return;
    // Only when it actually changes, or every pointer move re-renders the board.
    setPreview((current) =>
      current?.id === moved && current.stateId === target.id
        ? current
        : { id: moved, stateId: target.id },
    );
  }

  function onDragEnd(event: DragEndEvent) {
    const moved = event.active.id as string;
    const over = event.over?.id as string | undefined;
    const target = over ? columnOf(over) : undefined;
    const issue = issues.find((entry) => entry.id === moved);
    // A drop back into the column it came from is not a move. Skipping it
    // saves a mutation whose only visible effect would be a spinner.
    if (target && issue && issue.state.id !== target.id) {
      // Moved before the preview is dropped, so the optimistic update in the
      // hook has already landed by the time the card stops pretending. The
      // other order shows one frame of the card back in its old column.
      onMove(moved, target);
    }
    setPreview(null);
    setDragging(null);
  }

  return (
    <DndContext
      // Rect intersection rather than the default closest-centre: a column is
      // much taller than a card, and closest-centre picks the *card* nearest
      // the pointer even when it is in a different column, which makes a drop
      // near a column's edge land somewhere unexpected.
      collisionDetection={rectIntersection}
      onDragCancel={() => {
        setPreview(null);
        setDragging(null);
      }}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragStart={(event: DragStartEvent) =>
        setDragging(issues.find((entry) => entry.id === event.active.id) ?? null)
      }
      sensors={sensors}
    >
      <div className="flex min-h-0 flex-1 divide-x divide-border overflow-x-auto">
        {ordered.map((state) => (
          <Column
            busy={busy}
            issues={issues.filter((issue) => columnFor(issue) === state.id)}
            key={state.id}
            onSelect={onSelect}
            selectedId={selectedId}
            state={state}
            t={t}
          />
        ))}
      </div>

      {/*
        The travelling card. Rendered outside the columns so it is not clipped
        by their scroll containers, and so the card left behind can fade in
        place while this one follows the pointer.
      */}
      <DragOverlay dropAnimation={{ duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)" }}>
        {dragging ? (
          <div className="w-64 cursor-grabbing border border-border bg-card px-3 py-2 shadow-lg">
            <CardBody issue={dragging} t={t} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function Column({
  busy,
  issues,
  onSelect,
  selectedId,
  state,
  t,
}: {
  busy: boolean;
  issues: LinearIssue[];
  onSelect: (id: string) => void;
  selectedId?: string;
  state: LinearState;
  t: (key: string) => string;
}) {
  // Droppable in its own right, so an empty column can still be dropped into —
  // with only the cards registered there would be nothing to aim at.
  const { isOver, setNodeRef } = useDroppable({ id: state.id });

  return (
    <section
      aria-label={state.name}
      className={cn("flex w-64 shrink-0 flex-col transition-colors", isOver && "bg-muted/30")}
      ref={setNodeRef}
    >
      <div className="sticky top-0 flex items-center justify-between gap-2 border-b border-border bg-muted/20 px-3 py-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <StateDot type={state.type} />
          <span className="truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {state.name}
          </span>
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {issues.length}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <SortableContext
          items={issues.map((issue) => issue.id)}
          strategy={verticalListSortingStrategy}
        >
          <ul className="divide-y divide-border">
            {issues.map((issue) => (
              <Card
                busy={busy}
                issue={issue}
                key={issue.id}
                onSelect={onSelect}
                selected={selectedId === issue.id}
                t={t}
              />
            ))}
          </ul>
        </SortableContext>
        {issues.length === 0 && (
          <p className="px-3 py-2 text-[11px] text-muted-foreground">{t("boardEmpty")}</p>
        )}
      </div>
    </section>
  );
}

function Card({
  busy,
  issue,
  onSelect,
  selected,
  t,
}: {
  busy: boolean;
  issue: LinearIssue;
  onSelect: (id: string) => void;
  selected: boolean;
  t: (key: string) => string;
}) {
  const { attributes, isDragging, listeners, setNodeRef, transform, transition } = useSortable({
    disabled: busy,
    id: issue.id,
  });

  return (
    <li
      className={cn(
        "transition-colors",
        selected && "bg-muted/45",
        // The gap the card will drop into. The row stays mounted and holds its
        // height — removing it would collapse the column and make everything
        // below jump, which is the jitter the native drag had.
        isDragging && "opacity-0",
      )}
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
    >
      <button
        className="block w-full cursor-grab px-3 py-2 text-left transition-colors hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing"
        onClick={() => onSelect(issue.id)}
        type="button"
      >
        <CardBody issue={issue} t={t} />
      </button>
    </li>
  );
}

/** Shared by the row and the overlay, so the card in flight is the same card. */
function CardBody({ issue, t }: { issue: LinearIssue; t: (key: string) => string }) {
  return (
    <>
      <span className="block truncate text-[13px] font-medium">{issue.title}</span>
      <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="font-mono">{issue.identifier}</span>
        {issue.priority > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <span className={priorityTone(issue.priority)}>{t(`priority${issue.priority}`)}</span>
          </>
        )}
        {issue.assignee && (
          <>
            <span aria-hidden="true">·</span>
            <span className="truncate">{issue.assignee.name}</span>
          </>
        )}
      </span>
    </>
  );
}

/** The status mark. `size-4` and `shrink-0`, as every status mark here is. */
function StateDot({ type }: { type: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("flex size-4 shrink-0 items-center justify-center", stateTone(type))}
    >
      <span className="size-1.5 rounded-full bg-current" />
    </span>
  );
}
