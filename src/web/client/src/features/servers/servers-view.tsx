import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Check,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/cvui-badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loading } from "@/components/ui/loading";
import { useRegisterRefresh } from "@/components/refresh-registry";
import {
  listSshServers,
  openSshTerminal,
  probeSshServer,
  removeSshServer,
  saveSshServer,
  type SshServerProbe,
  type SshServerSummary,
} from "@/lib/api";
import { useT } from "@/lib/i18n";

const AUTO_PROBE_LIMIT = 12;

export function ServersView({ onOpenTerminal }: { onOpenTerminal: () => void }) {
  const t = useT();
  const [servers, setServers] = useState<SshServerSummary[]>([]);
  const [probes, setProbes] = useState<Record<string, SshServerProbe>>({});
  const [probing, setProbing] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SshServerSummary | null | "new">(null);
  const [saving, setSaving] = useState(false);

  const runProbe = useCallback(async (host: string) => {
    setProbing((current) => new Set(current).add(host));
    try {
      const probe = await probeSshServer(host);
      setProbes((current) => ({ ...current, [host]: probe }));
    } finally {
      setProbing((current) => {
        const next = new Set(current);
        next.delete(host);
        return next;
      });
    }
  }, []);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const next = await listSshServers();
      setServers(next);
      void Promise.all(next.slice(0, AUTO_PROBE_LIMIT).map((server) => runProbe(server.host)));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoading(false);
    }
  }, [runProbe]);

  useEffect(() => {
    void load();
  }, [load]);
  useRegisterRefresh(() => load(true));

  const reachable = useMemo(
    () => Object.values(probes).filter((probe) => probe.reachable).length,
    [probes],
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card/75 px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-medium">
          <Server aria-hidden="true" className="size-3.5 text-muted-foreground" />
          {t("servers.title")}
        </div>
        <div className="ml-auto flex items-center gap-2 font-mono text-[9px] tabular-nums text-muted-foreground">
          <span>{t("servers.summary", { reachable, total: servers.length })}</span>
          <Button onClick={() => setEditing("new")} size="sm" type="button">
            <Plus aria-hidden="true" />
            {t("servers.add")}
          </Button>
        </div>
      </div>

      {error ? (
        <Alert aria-live="polite" className="m-3 shrink-0" variant="destructive">
          {error}
        </Alert>
      ) : null}

      {editing ? (
        <ServerForm
          initial={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSave={async (values) => {
            setSaving(true);
            try {
              await saveSshServer(values);
              setEditing(null);
              await load(true);
            } finally {
              setSaving(false);
            }
          }}
          saving={saving}
        />
      ) : null}

      {loading && servers.length === 0 ? (
        <Loading className="flex-1" label={t("servers.loading")} />
      ) : servers.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="max-w-sm text-center">
            <Server aria-hidden="true" className="mx-auto size-7 text-muted-foreground" />
            <p className="mt-3 text-sm font-medium">{t("servers.emptyTitle")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("servers.emptyBody")}</p>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full table-fixed text-left text-xs">
            <thead className="sticky top-0 z-10 border-b border-border bg-background/95 text-[10px] uppercase tracking-wide text-muted-foreground backdrop-blur">
              <tr>
                <th className="w-[32%] px-3 py-2 font-semibold">{t("servers.server")}</th>
                <th className="w-[18%] px-3 py-2 font-semibold">{t("servers.environment")}</th>
                <th className="w-[28%] px-3 py-2 font-semibold">{t("servers.status")}</th>
                <th className="px-3 py-2 text-right font-semibold">{t("servers.actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {servers.map((server) => {
                const probe = probes[server.host];
                const isProbing = probing.has(server.host);
                return (
                  <tr className="group hover:bg-muted/20" key={server.host}>
                    <td className="px-3 py-2.5">
                      <div className="truncate font-medium" title={server.name ?? server.host}>
                        {server.name ?? server.host}
                      </div>
                      <div className="truncate font-mono text-[10px] text-muted-foreground" title={server.host}>
                        ssh {server.host}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      {server.environment ? (
                        <Badge appearance="subtle" size="small" variant="secondary">
                          {server.environment}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <ServerStatus probe={probe} probing={isProbing} />
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex justify-end gap-1 opacity-70 group-hover:opacity-100">
                        <IconButton
                          label={t("servers.test")}
                          onClick={() => void runProbe(server.host)}
                        >
                          <RefreshCw aria-hidden="true" className={isProbing ? "animate-spin motion-reduce:animate-none" : ""} />
                        </IconButton>
                        <IconButton
                          label={t("servers.terminal")}
                          onClick={() => {
                            void openSshTerminal(server.host).then(onOpenTerminal).catch((nextError) => {
                              setError(nextError instanceof Error ? nextError.message : String(nextError));
                            });
                          }}
                        >
                          <SquareTerminal aria-hidden="true" />
                        </IconButton>
                        <IconButton label={t("servers.edit")} onClick={() => setEditing(server)}>
                          <Pencil aria-hidden="true" />
                        </IconButton>
                        {server.saved ? (
                          <IconButton
                            label={t("servers.remove")}
                            onClick={() => {
                              void removeSshServer(server.host).then(() => load(true)).catch((nextError) => {
                                setError(nextError instanceof Error ? nextError.message : String(nextError));
                              });
                            }}
                          >
                            <Trash2 aria-hidden="true" />
                          </IconButton>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="border-t border-border px-3 py-2 text-[10px] text-muted-foreground">
            {t("servers.security")}
          </p>
        </div>
      )}
    </div>
  );
}

function ServerForm({
  initial,
  onCancel,
  onSave,
  saving,
}: {
  initial: SshServerSummary | null;
  onCancel: () => void;
  onSave: (values: { host: string; name?: string; environment?: string }) => Promise<void>;
  saving: boolean;
}) {
  const t = useT();
  const [host, setHost] = useState(initial?.host ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [environment, setEnvironment] = useState(initial?.environment ?? "");

  return (
    <form
      className="grid shrink-0 gap-3 border-b border-border bg-muted/20 px-3 py-3 sm:grid-cols-[minmax(150px,1fr)_minmax(150px,1fr)_minmax(120px,.7fr)_auto] sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave({
          host: host.trim(),
          name: name.trim() || undefined,
          environment: environment.trim() || undefined,
        });
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="server-host">{t("servers.host")}</Label>
        <Input
          autoFocus
          disabled={Boolean(initial?.saved)}
          id="server-host"
          onChange={(event) => setHost(event.target.value)}
          placeholder="prod-web"
          required
          value={host}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="server-name">{t("servers.name")}</Label>
        <Input
          id="server-name"
          onChange={(event) => setName(event.target.value)}
          placeholder={t("servers.namePlaceholder")}
          value={name}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="server-environment">{t("servers.environment")}</Label>
        <Input
          id="server-environment"
          onChange={(event) => setEnvironment(event.target.value)}
          placeholder="Production"
          value={environment}
        />
      </div>
      <div className="flex gap-1">
        <Button loading={saving} size="sm" type="submit">
          <Check aria-hidden="true" />
          {t("servers.save")}
        </Button>
        <Button disabled={saving} onClick={onCancel} size="sm" type="button" variant="outline">
          <X aria-hidden="true" />
          {t("servers.cancel")}
        </Button>
      </div>
    </form>
  );
}

function ServerStatus({ probe, probing }: { probe?: SshServerProbe; probing: boolean }) {
  const t = useT();
  if (probing) return <Badge isLoading size="small" variant="secondary">{t("servers.connecting")}</Badge>;
  if (!probe) return <span className="text-muted-foreground">{t("servers.notChecked")}</span>;
  if (!probe.reachable) {
    return (
      <div className="min-w-0">
        <Badge appearance="subtle" size="small" variant="error">{t("servers.offline")}</Badge>
        <div className="mt-1 truncate font-mono text-[9px] text-muted-foreground" title={probe.error}>
          {probe.error}
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Badge appearance="subtle" size="small" variant="success">{t("servers.online")}</Badge>
      <span className="truncate font-mono text-[9px] text-muted-foreground">
        {probe.hostname} · {probe.latencyMs} ms
      </span>
    </div>
  );
}

function IconButton({ children, label, onClick }: { children: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      aria-label={label}
      className="inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5"
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}
