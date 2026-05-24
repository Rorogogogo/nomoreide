import { useState } from "react";
import { ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addLogSource, type LogSource } from "@/lib/api";
import { ComposerDialog } from "./service-form/composer-dialog";

/** A `driver` source (journald/docker) supports server-side query; the rest tail. */
type SourceType = "journald" | "docker" | "ssh" | "file" | "command";

const TYPE_HINTS: Record<SourceType, string> = {
  journald: "Queries `journalctl -u <unit>` — time range, text, and level filter server-side. Add a host to run it over SSH.",
  docker: "Queries `docker logs <container>` — time window server-side. Add a host to run it over SSH.",
  ssh: "Reads via `ssh <host> tail -n 500 <path>` using your ~/.ssh/config + ssh-agent.",
  file: "Tails an absolute file path on this machine.",
  command: "Runs the command and treats its output as the log (kubectl logs, …).",
};

/** Dialog to register a saved log source (UAT/PROD/…). Calls back with the new list. */
export function LogSourceForm({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (sources: LogSource[], added: string) => void;
}) {
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
    <ComposerDialog icon={<ScrollText />} onClose={onClose} size="md" title="Add log source">
      <form
        className="flex flex-col gap-3 p-4 text-xs"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="Name">
          <Input
            autoFocus
            onChange={(event) => setName(event.target.value)}
            placeholder="PROD"
            value={name}
          />
        </Field>
        <Field label="Type">
          <select
            className="h-9 w-full rounded-md border border-border bg-background px-2 text-xs"
            onChange={(event) => setType(event.target.value as SourceType)}
            value={type}
          >
            <option value="journald">systemd journal (journald)</option>
            <option value="docker">Docker container</option>
            <option value="ssh">Remote file (SSH)</option>
            <option value="file">Local file</option>
            <option value="command">Command</option>
          </select>
          <p className="mt-1 text-[11px] text-muted-foreground">{TYPE_HINTS[type]}</p>
        </Field>

        {type === "journald" || type === "docker" ? (
          <Field label="Host (optional — leave blank to run locally)">
            <Input
              onChange={(event) => setHost(event.target.value)}
              placeholder="jobjourney-prod (an alias from ~/.ssh/config)"
              value={host}
            />
          </Field>
        ) : null}

        {type === "journald" ? (
          <Field label="Unit">
            <Input
              onChange={(event) => setUnit(event.target.value)}
              placeholder="jobjourney"
              value={unit}
            />
          </Field>
        ) : null}

        {type === "docker" ? (
          <Field label="Container">
            <Input
              onChange={(event) => setContainer(event.target.value)}
              placeholder="brainctl-api"
              value={container}
            />
          </Field>
        ) : null}

        {type === "ssh" ? (
          <Field label="Host">
            <Input
              onChange={(event) => setHost(event.target.value)}
              placeholder="prod (an alias from ~/.ssh/config)"
              value={host}
            />
          </Field>
        ) : null}

        {type === "file" || type === "ssh" ? (
          <Field label={type === "ssh" ? "Remote path" : "File path"}>
            <Input
              onChange={(event) => setPath(event.target.value)}
              placeholder="/var/log/app/out.log"
              value={path}
            />
          </Field>
        ) : null}

        {type === "command" ? (
          <>
            <Field label="Command">
              <Input
                onChange={(event) => setCommand(event.target.value)}
                placeholder="kubectl logs -l app=myapp --tail 500"
                value={command}
              />
            </Field>
            <Field label="Working directory (optional)">
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
            Cancel
          </Button>
          <Button disabled={saving || !name.trim()} size="sm" type="submit">
            {saving ? "Saving…" : "Add source"}
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
