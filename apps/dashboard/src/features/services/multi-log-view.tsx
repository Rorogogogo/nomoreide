import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { listLogSources, type LogSource } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { LogConsole } from "./service-detail/log-console";
import { encodeTarget, type LogTarget } from "./service-detail/use-logs";
import { type LogOption, LogTargetPicker } from "./service-detail/log-target-picker";
import { LogsOverlay } from "./service-detail/logs-tab";
import { LogSourceForm } from "./log-source-form";

const MAX_PANES = 4;

/**
 * Side-by-side log panes for watching several services and/or saved log sources
 * (UAT/PROD/…) at once. Each pane picks its own target and streams independently.
 */
export function MultiLogView({
  services,
  initialService,
  onClose,
}: {
  services: string[];
  initialService?: string;
  onClose: () => void;
}) {
  const t = useT();
  const [sources, setSources] = useState<LogSource[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [panes, setPanes] = useState<number[]>(() => [0]);
  const [paneTargets, setPaneTargets] = useState<Record<number, LogTarget>>(() => {
    const first: LogTarget | undefined = initialService
      ? { kind: "service", name: initialService }
      : services[0]
        ? { kind: "service", name: services[0] }
        : undefined;
    return first ? { 0: first } : ({} as Record<number, LogTarget>);
  });
  const nextIdRef = useRef(1);

  useEffect(() => {
    let cancelled = false;
    void listLogSources().then((result) => {
      if (!cancelled) setSources(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const options: LogOption[] = [
    ...services.map((name) => ({
      target: { kind: "service" as const, name },
      label: name,
      group: t("services.title"),
    })),
    ...sources.map((source) => ({
      target: { kind: "source" as const, name: source.name },
      label: source.name,
      group: t("services.log.sourcesGroup"),
    })),
  ];
  const allTargets: LogTarget[] = options.map((option) => option.target);

  function addPane() {
    if (panes.length >= MAX_PANES || allTargets.length === 0) return;
    const id = nextIdRef.current++;
    const used = new Set(Object.values(paneTargets).map(encodeTarget));
    const pick = allTargets.find((target) => !used.has(encodeTarget(target))) ?? allTargets[0];
    setPanes((current) => [...current, id]);
    setPaneTargets((current) => ({ ...current, [id]: pick }));
  }

  function removePane(id: number) {
    setPanes((current) => current.filter((paneId) => paneId !== id));
    setPaneTargets((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }

  function setPaneTarget(id: number, target: LogTarget) {
    setPaneTargets((current) => ({ ...current, [id]: target }));
  }

  function handleAdded(next: LogSource[], added: string) {
    setSources(next);
    // Point the first pane at the freshly added source so it shows immediately.
    const firstPane = panes[0];
    if (firstPane !== undefined) setPaneTarget(firstPane, { kind: "source", name: added });
  }

  const title = (
    <div className="flex items-center gap-3">
      <span>{t("services.logs")}</span>
      <Button onClick={() => setAddOpen(true)} size="sm" type="button" variant="outline">
        <Plus />
        {t("services.log.addSource")}
      </Button>
      <Button
        disabled={panes.length >= MAX_PANES || allTargets.length === 0}
        onClick={addPane}
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus />
        {t("services.log.addPane")}
      </Button>
    </div>
  );

  return (
    <>
      <LogsOverlay maxWidthClass="max-w-[1500px]" onClose={onClose} title={title}>
        {allTargets.length === 0 ? (
          <div className="grid h-full place-items-center text-center text-muted-foreground">
            <div>
              <p>{t("services.log.noneYet")}</p>
              <Button className="mt-2" onClick={() => setAddOpen(true)} size="sm" type="button">
                <Plus />
                {t("services.log.addLogSource")}
              </Button>
            </div>
          </div>
        ) : (
          <div
            className={cn(
              "grid h-full min-h-0 gap-3",
              panes.length > 1 ? "lg:grid-cols-2" : "grid-cols-1",
              panes.length > 2 ? "lg:grid-rows-2" : "grid-rows-1",
            )}
          >
            {panes.map((id) => (
              <LogPane
                key={id}
                onChangeTarget={(target) => setPaneTarget(id, target)}
                onRemove={panes.length > 1 ? () => removePane(id) : undefined}
                options={options}
                target={paneTargets[id] ?? allTargets[0]}
              />
            ))}
          </div>
        )}
      </LogsOverlay>
      {addOpen ? (
        <LogSourceForm onAdded={handleAdded} onClose={() => setAddOpen(false)} />
      ) : null}
    </>
  );
}

function LogPane({
  options,
  target,
  onChangeTarget,
  onRemove,
}: {
  options: LogOption[];
  target: LogTarget;
  onChangeTarget: (target: LogTarget) => void;
  onRemove?: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [streaming, setStreaming] = useState(true);
  const [hideStdout, setHideStdout] = useState(false);

  return (
    <div className="flex min-h-0 min-w-0 flex-col rounded-lg border border-border bg-background/60 p-2">
      <LogConsole
        fill
        hideStdout={hideStdout}
        leading={<LogTargetPicker onChange={onChangeTarget} options={options} target={target} />}
        query={query}
        setHideStdout={setHideStdout}
        setQuery={setQuery}
        setStreaming={setStreaming}
        streaming={streaming}
        target={target}
        trailing={
          onRemove ? (
            <Button
              aria-label={t("services.log.removePane")}
              onClick={onRemove}
              size="icon"
              type="button"
              variant="ghost"
            >
              <X />
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}
