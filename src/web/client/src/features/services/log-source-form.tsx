import { useState } from "react";
import { ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addLogSource, type LogSource } from "@/lib/api";
import { useT } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/i18n/en";
import { ComposerDialog } from "./service-form/composer-dialog";

/** A `driver` source (journald/docker) supports server-side query; the rest tail. */
type SourceType = "journald" | "docker" | "ssh" | "file" | "command";

const TYPE_HINT_KEYS: Record<SourceType, TranslationKey> = {
  journald: "services.log.hint.journald",
  docker: "services.log.hint.docker",
  ssh: "services.log.hint.ssh",
  file: "services.log.hint.file",
  command: "services.log.hint.command",
};

/** Dialog to register a saved log source (UAT/PROD/…). Calls back with the new list. */
export function LogSourceForm({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (sources: LogSource[], added: string) => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [type, setType] = useState<SourceType>("journald");
  const [host, setHost] = useState("");
  const [path, setPath] = useState("");
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState("");
  const [unit, setUnit] = useState("");
  const [container, setContainer] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    setError(undefined);
    try {
      // Driver sources keep a neutral `kind`; the driver drives the query.
      const payload: LogSource = { name: name.trim(), kind: "command" };
      if (type === "file") {
        payload.kind = "file";
        payload.path = path.trim();
      } else if (type === "ssh") {
        payload.kind = "ssh";
        payload.host = host.trim();
        payload.path = path.trim();
      } else if (type === "command") {
        payload.kind = "command";
        payload.command = command.trim();
        if (cwd.trim()) payload.cwd = cwd.trim();
      } else if (type === "journald") {
        payload.driver = "journald";
        payload.unit = unit.trim();
        if (host.trim()) payload.host = host.trim();
      } else if (type === "docker") {
        payload.driver = "docker";
        payload.container = container.trim();
        if (host.trim()) payload.host = host.trim();
      }
      const sources = await addLogSource(payload);
      onAdded(sources, payload.name);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ComposerDialog icon={<ScrollText />} onClose={onClose} size="md" title={t("services.log.addSourceTitle")}>
      <form
        className="flex flex-col gap-3 p-4 text-xs"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label={t("services.log.name")}>
          <Input
            autoFocus
            onChange={(event) => setName(event.target.value)}
            placeholder="PROD"
            value={name}
          />
        </Field>
        <Field label={t("services.log.type")}>
          <select
            className="h-9 w-full rounded-md border border-border bg-background px-2 text-xs"
            onChange={(event) => setType(event.target.value as SourceType)}
            value={type}
          >
            <option value="journald">{t("services.log.typeJournald")}</option>
            <option value="docker">{t("services.log.typeDocker")}</option>
            <option value="ssh">{t("services.log.typeSsh")}</option>
            <option value="file">{t("services.log.typeFile")}</option>
            <option value="command">{t("services.log.typeCommand")}</option>
          </select>
          <p className="mt-1 text-[11px] text-muted-foreground">{t(TYPE_HINT_KEYS[type])}</p>
        </Field>

        {type === "journald" || type === "docker" ? (
          <Field label={t("services.log.hostOptional")}>
            <Input
              onChange={(event) => setHost(event.target.value)}
              placeholder="jobjourney-prod (an alias from ~/.ssh/config)"
              value={host}
            />
          </Field>
        ) : null}

        {type === "journald" ? (
          <Field label={t("services.log.unit")}>
            <Input
              onChange={(event) => setUnit(event.target.value)}
              placeholder="jobjourney"
              value={unit}
            />
          </Field>
        ) : null}

        {type === "docker" ? (
          <Field label={t("services.log.container")}>
            <Input
              onChange={(event) => setContainer(event.target.value)}
              placeholder="brainctl-api"
              value={container}
            />
          </Field>
        ) : null}

        {type === "ssh" ? (
          <Field label={t("services.log.host")}>
            <Input
              onChange={(event) => setHost(event.target.value)}
              placeholder="prod (an alias from ~/.ssh/config)"
              value={host}
            />
          </Field>
        ) : null}

        {type === "file" || type === "ssh" ? (
          <Field label={type === "ssh" ? t("services.log.remotePath") : t("services.log.filePath")}>
            <Input
              onChange={(event) => setPath(event.target.value)}
              placeholder="/var/log/app/out.log"
              value={path}
            />
          </Field>
        ) : null}

        {type === "command" ? (
          <>
            <Field label={t("services.log.command")}>
              <Input
                onChange={(event) => setCommand(event.target.value)}
                placeholder="kubectl logs -l app=myapp --tail 500"
                value={command}
              />
            </Field>
            <Field label={t("services.log.cwdOptional")}>
              <Input
                onChange={(event) => setCwd(event.target.value)}
                placeholder="/srv/app"
                value={cwd}
              />
            </Field>
          </>
        ) : null}

        {error ? <div className="text-red-600">{error}</div> : null}

        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            {t("common.cancel")}
          </Button>
          <Button disabled={saving || !name.trim()} size="sm" type="submit">
            {saving ? t("common.saving") : t("services.log.addSource")}
          </Button>
        </div>
      </form>
    </ComposerDialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
