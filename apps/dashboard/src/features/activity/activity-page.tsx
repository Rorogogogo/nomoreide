import { Box, Check, ChevronDown, Server } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useRegisterRefresh } from "@/components/refresh-registry";
import {
  getDockerStatus,
  listSshServers,
  type DashboardData,
  type SshServerSummary,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ActivityView } from "./activity-view";
import { DockerActivityView } from "./docker-activity-view";
import { RemoteActivityView } from "./remote-activity-view";


export function ActivityPage({
  data,
  host,
  onHostChange,
  onOpenService,
  scopeName,
}: {
  data: DashboardData;
  host: string;
  onHostChange: (host: string) => void;
  onOpenService: (name: string) => void;
  scopeName: string | null;
}) {
  const [servers, setServers] = useState<SshServerSummary[]>([]);
  /**
   * Whether Docker is worth offering, asked once rather than assumed.
   *
   * The option is hidden when the daemon is not there. A source that is always
   * listed and always empty teaches people to ignore the selector, and this one
   * has to stay worth opening.
   */
  const [dockerAvailable, setDockerAvailable] = useState(false);

  const loadServers = useCallback(async () => {
    setServers(await listSshServers().catch(() => []));
  }, []);
  const loadDocker = useCallback(async () => {
    const status = await getDockerStatus().catch(() => null);
    setDockerAvailable(status?.available ?? false);
  }, []);
  useEffect(() => {
    void loadServers();
    void loadDocker();
  }, [loadDocker, loadServers]);
  useRegisterRefresh(({ manual }) =>
    manual ? Promise.all([loadServers(), loadDocker()]).then(() => undefined) : undefined,
  );

  const selected = servers.find((server) => server.host === host);
  // Docker stays selectable once chosen even if the daemon stops answering, so
  // the view can explain that rather than silently bouncing back to local.
  const showDocker = host === DOCKER_HOST;
  const hostSelector = (
    <ActivityHostSelect
      dockerAvailable={dockerAvailable || showDocker}
      host={showDocker ? DOCKER_HOST : selected ? host : "local"}
      onHostChange={onHostChange}
      servers={servers}
    />
  );

  if (showDocker) {
    return <DockerActivityView headerControl={hostSelector} />;
  }

  return (
    selected ? (
      <RemoteActivityView
        headerControl={hostSelector}
        key={selected.host}
        server={selected}
      />
    ) : (
      <ActivityView
        data={data}
        headerControl={hostSelector}
        onOpenService={onOpenService}
        scopeName={scopeName}
      />
    )
  );
}

/**
 * The selector value that means containers rather than a machine.
 *
 * Not a hostname, and it cannot collide with one: an SSH host is matched by
 * exact `server.host`, and no SSH entry is named `docker` without a user
 * deliberately registering one — in which case they get the containers view,
 * which is the reading a person who typed `docker` would expect anyway.
 */
export const DOCKER_HOST = "docker";

function ActivityHostSelect({
  dockerAvailable,
  host,
  onHostChange,
  servers,
}: {
  dockerAvailable: boolean;
  host: string;
  onHostChange: (host: string) => void;
  servers: SshServerSummary[];
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ left: 0, top: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selected = servers.find((server) => server.host === host);
  const label =
    host === DOCKER_HOST
      ? t("activity.docker.source")
      : (selected?.name ?? selected?.host ?? t("activity.thisMachine"));

  function toggle() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const menuWidth = Math.max(rect.width, 192);
      setCoords({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8)),
        top: rect.bottom + 4,
      });
    }
    setOpen((value) => !value);
  }

  useEffect(() => {
    if (!open) return;
    function dismiss(event: PointerEvent) {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    }
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    const dismissOnViewportChange = () => setOpen(false);
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissOnEscape);
    window.addEventListener("resize", dismissOnViewportChange);
    window.addEventListener("scroll", dismissOnViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissOnEscape);
      window.removeEventListener("resize", dismissOnViewportChange);
      window.removeEventListener("scroll", dismissOnViewportChange, true);
    };
  }, [open]);

  function choose(nextHost: string) {
    setOpen(false);
    onHostChange(nextHost);
  }

  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`${t("activity.host")}: ${label}`}
        className={cn(
          "flex h-6 min-w-0 max-w-44 items-center gap-1 rounded border border-border bg-background px-1.5 text-[10px] text-foreground transition-colors hover:bg-muted",
          open && "bg-muted",
        )}
        onClick={toggle}
        ref={triggerRef}
        title={`${t("activity.host")}: ${label}`}
        type="button"
      >
        {host === DOCKER_HOST ? (
          <Box aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <Server aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{label}</span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open
        ? createPortal(
            <div
              aria-label={t("activity.host")}
              className="fixed z-[100] max-h-72 min-w-48 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
              ref={menuRef}
              role="menu"
              style={coords}
            >
              <ActivityHostOption
                active={host === "local"}
                label={t("activity.thisMachine")}
                onSelect={() => choose("local")}
              />
              {dockerAvailable ? (
                <ActivityHostOption
                  active={host === DOCKER_HOST}
                  detail={t("activity.docker.sourceDetail")}
                  label={t("activity.docker.source")}
                  onSelect={() => choose(DOCKER_HOST)}
                />
              ) : null}
              {servers.map((server) => (
                <ActivityHostOption
                  active={host === server.host}
                  detail={server.environment
                    ? `${server.environment} · ${server.host}`
                    : server.host}
                  key={server.host}
                  label={server.name ?? server.host}
                  onSelect={() => choose(server.host)}
                />
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function ActivityHostOption({
  active,
  detail,
  label,
  onSelect,
}: {
  active: boolean;
  detail?: string;
  label: string;
  onSelect: () => void;
}) {
  return (
    <button
      aria-checked={active}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-muted",
        active && "bg-muted/60",
      )}
      onClick={onSelect}
      role="menuitemradio"
      type="button"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs">{label}</span>
        {detail ? (
          <span className="block truncate font-mono text-[9px] text-muted-foreground">
            {detail}
          </span>
        ) : null}
      </span>
      {active ? (
        <Check aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      ) : null}
    </button>
  );
}
