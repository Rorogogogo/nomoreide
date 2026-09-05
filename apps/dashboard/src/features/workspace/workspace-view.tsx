import { Activity, useId, useRef, useState, type ReactNode } from "react";
import { Columns2, SquareSplitHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { clampRatio, closeTab, mergePanes, moveTab, openTab, splitActive, tabId, type WorkspaceLayout, type WorkspaceTab } from "./workspace-layout";

/** What a drag is carrying, while it is in the air. */
interface Dragging { pane: number; index: number }

export function WorkspaceView({ layout, update, options, title, render }: {
  layout: WorkspaceLayout;
  update: (change: (layout: WorkspaceLayout) => WorkspaceLayout) => void;
  options: WorkspaceTab[];
  title: (tab: WorkspaceTab) => string;
  render: (tab: WorkspaceTab, pane: number) => ReactNode;
}) {
  const t = useT();
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const split = layout.panes.length === 2;
  /*
    Held in React state rather than read back out of `dataTransfer`, because
    `dragover` cannot read it — the drag data is only exposed on `drop`, and
    the strip needs to know *now* whether to show a drop marker.
  */
  const [dragging, setDragging] = useState<Dragging | null>(null);
  const [dropAt, setDropAt] = useState<{ pane: number; index: number } | null>(null);
  const select = (pane: number, active: number) => update((current) => ({ ...current, focused: pane, panes: current.panes.map((entry, i) => i === pane ? { ...entry, active } : entry) }));
  const endDrag = () => { setDragging(null); setDropAt(null); };
  const drop = (pane: number, index: number) => {
    if (dragging) update((current) => moveTab(current, dragging.pane, dragging.index, pane, index));
    endDrag();
  };
  return (
    <div ref={container} className="flex h-full min-h-0 min-w-0 flex-col overflow-x-hidden overflow-y-auto bg-background md:flex-row md:overflow-hidden" data-workspace-split={split}>
      {layout.panes.map((pane, paneIndex) => (
        <div key={pane.id} className="contents">
          {paneIndex === 1 ? (
            <hr
              tabIndex={0} aria-label={t("workspace.resize")} aria-orientation="vertical"
              aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(layout.ratio)}
              /*
                A one-pixel line with a nine-pixel grab area around it. The
                divider used to be four pixels of solid border, which reads as
                a gutter between two documents rather than the seam it is —
                and a hairline you cannot grab is the opposite mistake, so the
                target is widened with a pseudo-element instead of with paint.
              */
              className="group relative hidden h-auto w-px shrink-0 self-stretch border-0 touch-none cursor-col-resize bg-border transition-colors before:absolute before:inset-y-0 before:-left-1 before:-right-1 before:content-[''] hover:bg-primary focus-visible:bg-primary focus-visible:outline-none md:block"
              onDoubleClick={() => update((current) => ({ ...current, ratio: 50 }))}
              onKeyDown={(event) => {
                const delta = event.key === "ArrowLeft" ? -5 : event.key === "ArrowRight" ? 5 : 0;
                if (!delta && event.key !== "Home" && event.key !== "End") return;
                event.preventDefault();
                update((current) => ({ ...current, ratio: event.key === "Home" ? 25 : event.key === "End" ? 75 : clampRatio(current.ratio + delta) }));
              }}
              onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }}
              onPointerMove={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                const rect = container.current?.getBoundingClientRect();
                if (rect?.width) {
                  const ratio = clampRatio(100 * (event.clientX - rect.left) / rect.width);
                  update((current) => ({ ...current, ratio }));
                }
              }}
              onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
            />
          ) : null}
          <section
            aria-label={t(paneIndex === 0 ? "workspace.primary" : "workspace.secondary")}
            className="flex min-h-[480px] min-w-0 flex-1 flex-col overflow-hidden md:min-h-0"
            style={{ flexGrow: split ? (paneIndex === 0 ? layout.ratio : 100 - layout.ratio) : 1, flexBasis: 0 }}
            onPointerDownCapture={() => { if (layout.focused !== paneIndex) update((current) => ({ ...current, focused: paneIndex })); }}
            onFocusCapture={() => { if (layout.focused !== paneIndex) update((current) => ({ ...current, focused: paneIndex })); }}
          >
            <div className={cn("flex shrink-0 items-center gap-1 border-b border-border px-2 py-1", layout.focused === paneIndex && "bg-muted/20")}>
              <div
                className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto" role="tablist" aria-label={t("workspace.tabs")}
                /* Dropping past the last tab appends, which is what the empty
                   space to the right of a tab strip looks like it should do. */
                onDragOver={(event) => { if (dragging) { event.preventDefault(); setDropAt({ pane: paneIndex, index: pane.tabs.length }); } }}
                onDrop={(event) => { if (dragging) { event.preventDefault(); drop(paneIndex, pane.tabs.length); } }}
              >
                {pane.tabs.map((tab, index) => {
                  const active = pane.active === index;
                  const marked = dropAt?.pane === paneIndex && dropAt.index === index;
                  const closable = split || pane.tabs.length > 1;
                  return (
                    /*
                      The wrapper carries the tab's appearance; the label and
                      the close sit inside it. They used to be two adjacent
                      controls with their own backgrounds, which is why the
                      close read as a button bolted to the side rather than as
                      part of the tab.

                      It holds no handlers of its own — dragging belongs to the
                      tab button below, which is both the thing being dragged
                      and an element that already has a role. Hanging drag
                      listeners on a plain div would make it interactive
                      without being reachable any other way.
                    */
                    <div
                      key={tabId(tab)}
                      className={cn(
                        "group flex shrink-0 items-center rounded border border-transparent pl-2 pr-1 text-[11px] transition-colors",
                        active ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                        marked && "border-l-primary",
                        dragging?.pane === paneIndex && dragging.index === index && "opacity-50",
                      )}
                    >
                      <button
                        type="button" role="tab" id={`${id}-${paneIndex}-${index}-tab`} aria-controls={`${id}-${paneIndex}-${index}-panel`}
                        aria-selected={active} tabIndex={active ? 0 : -1}
                        className="max-w-40 truncate py-1 focus-visible:outline focus-visible:outline-2"
                        draggable
                        onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", tabId(tab)); setDragging({ pane: paneIndex, index }); }}
                        onDragEnd={endDrag}
                        onDragOver={(event) => { if (dragging) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropAt({ pane: paneIndex, index }); } }}
                        onDrop={(event) => { if (dragging) { event.preventDefault(); event.stopPropagation(); drop(paneIndex, index); } }}
                        onClick={() => select(paneIndex, index)}
                        onKeyDown={(event) => {
                          const next = event.key === "ArrowRight" ? (index + 1) % pane.tabs.length : event.key === "ArrowLeft" ? (index + pane.tabs.length - 1) % pane.tabs.length : event.key === "Home" ? 0 : event.key === "End" ? pane.tabs.length - 1 : null;
                          if (next === null) return;
                          event.preventDefault(); select(paneIndex, next);
                          document.getElementById(`${id}-${paneIndex}-${next}-tab`)?.focus();
                        }}
                      >{title(tab)}</button>
                      {closable ? (
                        <button
                          type="button"
                          aria-label={t("workspace.closeTab", { name: title(tab) })}
                          /*
                            Visible on the active tab and on hover, like a
                            browser's. An × on every tab at rest turns a strip
                            of five into five things asking to be dismissed.
                            It keeps its space either way, so nothing shifts
                            when the pointer arrives.
                          */
                          className={cn(
                            "ml-1 rounded-sm p-0.5 opacity-0 transition-opacity focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 group-hover:opacity-100",
                            active ? "opacity-70 hover:bg-background/20" : "hover:bg-foreground/10",
                          )}
                          onClick={(event) => { event.stopPropagation(); update((current) => closeTab(current, paneIndex, index)); }}
                        ><X aria-hidden className="size-3" /></button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              <select
                aria-label={t("workspace.openTab")} title={t("workspace.openTab")} value=""
                className="w-7 shrink-0 bg-transparent text-xs"
                onChange={(event) => { const tab = options[Number(event.target.value)]; if (tab) update((current) => openTab(current, tab, paneIndex)); }}
              >
                <option value="" disabled>+</option>
                {options.map((tab, index) => <option key={tabId(tab)} value={index}>{title(tab)}</option>)}
              </select>
              {paneIndex === 0 && !split ? (
                <Button
                  variant="ghost" size="icon" className="size-6 shrink-0"
                  aria-label={t("workspace.openBeside")} title={t("workspace.openBeside")}
                  onClick={() => update((current) => splitActive(current, options))}
                ><SquareSplitHorizontal aria-hidden className="size-3.5" /></Button>
              ) : null}
              {paneIndex === 1 ? (
                <Button
                  variant="ghost" size="icon" className="size-6 shrink-0"
                  aria-label={t("workspace.singlePane")} title={t("workspace.singlePane")}
                  onClick={() => update(mergePanes)}
                ><Columns2 aria-hidden className="size-3.5" /></Button>
              ) : null}
            </div>
            {pane.tabs.map((tab, index) => (
              <Activity key={tabId(tab)} mode={pane.active === index ? "visible" : "hidden"}>
                <div role="tabpanel" id={`${id}-${paneIndex}-${index}-panel`} aria-labelledby={`${id}-${paneIndex}-${index}-tab`} className="@container/workspace min-h-0 flex-1 overflow-hidden">
                  {render(tab, paneIndex)}
                </div>
              </Activity>
            ))}
          </section>
        </div>
      ))}
      {/*
        A drop zone that only exists mid-drag, and only before the split. It is
        how a tab dragged to the right-hand edge *creates* the second pane —
        the same gesture a browser uses to tear a tab into its own window.
      */}
      {dragging && !split ? (
        <div
          aria-hidden
          className={cn("hidden w-16 shrink-0 self-stretch border-l-2 border-dashed transition-colors md:block", dropAt?.pane === 1 ? "border-primary bg-primary/10" : "border-border")}
          onDragOver={(event) => { event.preventDefault(); setDropAt({ pane: 1, index: 0 }); }}
          onDrop={(event) => { event.preventDefault(); drop(1, 0); }}
        />
      ) : null}
    </div>
  );
}
