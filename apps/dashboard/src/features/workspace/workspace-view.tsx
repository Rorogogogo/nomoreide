import { Activity, useId, useRef, type ReactNode } from "react";
import { Columns2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { clampRatio, closeTab, mergePanes, openTab, tabId, type WorkspaceLayout, type WorkspaceTab } from "./workspace-layout";

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
  const select = (pane: number, active: number) => update((current) => ({ ...current, focused: pane, panes: current.panes.map((entry, i) => i === pane ? { ...entry, active } : entry) }));
  return (
    <div ref={container} className="flex h-full min-h-0 min-w-0 flex-col overflow-x-hidden overflow-y-auto bg-background md:flex-row md:overflow-hidden" data-workspace-split={split}>
      {layout.panes.map((pane, paneIndex) => (
        <div key={pane.id} className="contents">
          {paneIndex === 1 ? (
            <hr
              tabIndex={0} aria-label={t("workspace.resize")} aria-orientation="vertical"
              aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(layout.ratio)}
              className="hidden h-auto w-1 shrink-0 self-stretch border-0 touch-none cursor-col-resize bg-border hover:bg-primary focus-visible:bg-primary focus-visible:outline-none md:block"
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
              <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto" role="tablist" aria-label={t("workspace.tabs")}>
                {pane.tabs.map((tab, index) => (
                  <div key={tabId(tab)} className="flex shrink-0 items-center">
                    <button
                      type="button" role="tab" id={`${id}-${paneIndex}-${index}-tab`} aria-controls={`${id}-${paneIndex}-${index}-panel`}
                      aria-selected={pane.active === index} tabIndex={pane.active === index ? 0 : -1}
                      className={cn("max-w-40 truncate rounded px-2 py-1 text-[11px] focus-visible:outline focus-visible:outline-2", pane.active === index ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}
                      onClick={() => select(paneIndex, index)}
                      onKeyDown={(event) => {
                        const next = event.key === "ArrowRight" ? (index + 1) % pane.tabs.length : event.key === "ArrowLeft" ? (index + pane.tabs.length - 1) % pane.tabs.length : event.key === "Home" ? 0 : event.key === "End" ? pane.tabs.length - 1 : null;
                        if (next === null) return;
                        event.preventDefault(); select(paneIndex, next);
                        document.getElementById(`${id}-${paneIndex}-${next}-tab`)?.focus();
                      }}
                    >{title(tab)}</button>
                    {split || pane.tabs.length > 1 ? <Button variant="ghost" size="icon" className="size-5" aria-label={t("workspace.closeTab", { name: title(tab) })} onClick={() => update((current) => closeTab(current, paneIndex, index))}><X aria-hidden className="size-3" /></Button> : null}
                  </div>
                ))}
              </div>
              <select
                aria-label={t("workspace.openTab")} title={t("workspace.openTab")} value=""
                className="w-7 shrink-0 bg-transparent text-xs"
                onChange={(event) => { const tab = options[Number(event.target.value)]; if (tab) update((current) => openTab(current, tab, paneIndex)); }}
              >
                <option value="" disabled>+</option>
                {options.map((tab, index) => <option key={tabId(tab)} value={index}>{title(tab)}</option>)}
              </select>
              {paneIndex === 0 ? <select
                aria-label={t("workspace.openBeside")} title={t("workspace.openBeside")} value=""
                className="max-w-28 bg-transparent text-[11px] text-muted-foreground"
                onChange={(event) => { const tab = options[Number(event.target.value)]; if (tab) update((current) => {
                  // Move an existing tab instead of mounting the same destination twice.
                  const source = current.panes[0];
                  const index = source.tabs.findIndex((entry) => tabId(entry) === tabId(tab));
                  if (index >= 0) {
                    if (source.tabs.length === 1) return current;
                    return openTab(closeTab(current, 0, index), tab, 1);
                  }
                  return openTab(current, tab, 1);
                }); }}
              >
                <option value="" disabled>{t("workspace.openBeside")}</option>
                {options.map((tab, index) => <option key={tabId(tab)} value={index} disabled={pane.tabs.length === 1 && tabId(pane.tabs[0]) === tabId(tab)}>{title(tab)}</option>)}
              </select> : <Button variant="ghost" size="icon" className="size-6" aria-label={t("workspace.singlePane")} title={t("workspace.singlePane")} onClick={() => update(mergePanes)}><Columns2 aria-hidden className="size-3.5" /></Button>}
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
    </div>
  );
}
