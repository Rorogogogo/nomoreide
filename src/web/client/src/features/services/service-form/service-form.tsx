import { Terminal } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ServiceDefinition } from "@/lib/api";
import { ProcessBadge } from "../process-badge";
import { kindOptions, serviceCommandPresets } from "./presets";
import { ServiceTestAlert } from "./service-test-alert";
import { useServiceForm } from "./use-service-form";

export function ServiceForm({
  cwd,
  onRefresh,
  onSaved,
  initialService,
}: {
  cwd: string;
  onRefresh: () => Promise<void>;
  onSaved?: () => void;
  initialService?: ServiceDefinition;
}) {
  const {
    editing,
    kind,
    setKind,
    name,
    setName,
    command,
    setCommand,
    formCwd,
    setFormCwd,
    port,
    setPort,
    description,
    setDescription,
    composeFile,
    setComposeFile,
    composeService,
    setComposeService,
    host,
    setHost,
    testResult,
    testing,
    submit,
    testCommand,
  } = useServiceForm({ cwd, onRefresh, onSaved, initialService });

  const activeKind = kindOptions.find((option) => option.value === kind)!;
  const canTest = kind === "local" && command.trim().length > 0 && formCwd.trim().length > 0;

  const sectionClass =
    "grid gap-2 rounded-md border border-border bg-muted/30 p-3";
  const legendClass =
    "px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";

  return (
    <form className="grid gap-3" onSubmit={submit}>
      <div className="grid gap-3 sm:grid-cols-2">
      <fieldset className={`${sectionClass} sm:col-span-2`}>
        <legend className={legendClass}>Step 1 · Service kind</legend>
        <div className="grid grid-cols-3 gap-1.5">
          {kindOptions.map((option) => (
            <Button
              className="justify-center"
              disabled={editing}
              key={option.value}
              onClick={() => setKind(option.value)}
              size="sm"
              type="button"
              variant={kind === option.value ? "default" : "outline"}
            >
              {option.label}
            </Button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">{activeKind.hint}</p>
      </fieldset>

      <div className="grid gap-3 sm:col-start-1 sm:row-start-2 sm:self-start">
        <fieldset className={sectionClass}>
          <legend className={legendClass}>Step 2 · Identity</legend>
          <Label>
            Name
            <Input
              className="h-8 text-sm"
              name="name"
              onChange={(event) => setName(event.target.value)}
              placeholder="backend"
              readOnly={editing}
              required
              value={name}
            />
            {editing ? (
              <span className="text-[11px] text-muted-foreground">
                Name is the service key and can't be changed here.
              </span>
            ) : null}
          </Label>
          <Label>
            Description
            <Input
              className="h-8 text-sm"
              name="description"
              onChange={(event) => setDescription(event.target.value)}
              placeholder="API server"
              value={description}
            />
          </Label>
        </fieldset>
        <fieldset className={sectionClass}>
          <legend className={legendClass}>Step 4 · Networking (optional)</legend>
          <Label>
            Port
            <Input
              className="h-8 text-sm"
              inputMode="numeric"
              name="port"
              onChange={(event) => setPort(event.target.value)}
              placeholder="3001"
              value={port}
            />
          </Label>
        </fieldset>
      </div>

      {kind === "local" ? (
        <fieldset className={`${sectionClass} sm:col-start-2 sm:row-start-2 sm:self-start`}>
          <legend className={legendClass}>Step 3 · Local command</legend>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {serviceCommandPresets.map((preset) => (
              <Button
                className="justify-start gap-1.5"
                key={preset.label}
                onClick={() => {
                  setCommand(preset.command);
                  setDescription(preset.description);
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                <ProcessBadge command={preset.badgeCommand ?? preset.command} compact />
                <span className="truncate">{preset.label}</span>
              </Button>
            ))}
          </div>
          <Label>
            Command
            <Input
              className="h-8 font-mono text-sm"
              name="command"
              onChange={(event) => setCommand(event.target.value)}
              placeholder="npm run dev"
              required
              value={command}
            />
          </Label>
          <Label>
            Working Directory
            <Input
              className="h-8 font-mono text-sm"
              name="cwd"
              onChange={(event) => setFormCwd(event.target.value)}
              required
              value={formCwd}
            />
          </Label>
        </fieldset>
      ) : null}

      {kind === "docker-compose" ? (
        <fieldset className={`${sectionClass} sm:col-start-2 sm:row-start-2 sm:self-start`}>
          <legend className={legendClass}>Step 3 · Docker Compose target</legend>
          <Label>
            Compose Service
            <Input
              className="h-8 font-mono text-sm"
              name="composeService"
              onChange={(event) => setComposeService(event.target.value)}
              placeholder="api"
              required
              value={composeService}
            />
          </Label>
          <Label>
            Compose File (optional)
            <Input
              className="h-8 font-mono text-sm"
              name="composeFile"
              onChange={(event) => setComposeFile(event.target.value)}
              placeholder="docker-compose.yml"
              value={composeFile}
            />
          </Label>
          <Label>
            Working Directory (where compose file lives)
            <Input
              className="h-8 font-mono text-sm"
              name="cwd"
              onChange={(event) => setFormCwd(event.target.value)}
              required
              value={formCwd}
            />
          </Label>
        </fieldset>
      ) : null}

      {kind === "ssh" ? (
        <fieldset className={`${sectionClass} sm:col-start-2 sm:row-start-2 sm:self-start`}>
          <legend className={legendClass}>Step 3 · SSH connection</legend>
          <Label>
            SSH Host (alias from ~/.ssh/config)
            <Input
              className="h-8 font-mono text-sm"
              name="host"
              onChange={(event) => setHost(event.target.value)}
              placeholder="devbox"
              required
              value={host}
            />
          </Label>
          <Label>
            Remote Command
            <Input
              className="h-8 font-mono text-sm"
              name="command"
              onChange={(event) => setCommand(event.target.value)}
              placeholder="npm run dev"
              required
              value={command}
            />
          </Label>
          <Label>
            Remote Working Directory
            <Input
              className="h-8 font-mono text-sm"
              name="cwd"
              onChange={(event) => setFormCwd(event.target.value)}
              placeholder="/srv/app"
              required
              value={formCwd}
            />
          </Label>
          <Alert variant="muted">
            <div className="font-medium">SSH key handling</div>
            <div className="mt-1 text-xs">
              NoMoreIDE never stores key files. Add a <code>Host {host || "&lt;alias&gt;"}</code> entry to
              <code> ~/.ssh/config</code> with <code>HostName</code>, <code>User</code>, and{" "}
              <code>IdentityFile ~/.ssh/your-key.pem</code> (chmod 0600). Make sure{" "}
              <code>ssh-agent</code> is running or your key is loaded
              (<code>ssh-add ~/.ssh/your-key.pem</code>). NoMoreIDE will run{" "}
              <code>ssh {host || "&lt;alias&gt;"}</code> using that config.
            </div>
          </Alert>
        </fieldset>
      ) : null}

      </div>

      {testResult ? <ServiceTestAlert result={testResult} /> : null}
      <div className="flex flex-wrap justify-end gap-2">
        {kind === "local" ? (
          <Button
            disabled={testing || !canTest}
            onClick={testCommand}
            type="button"
            variant="outline"
          >
            <Terminal />
            {testing ? "Testing..." : "Test Command"}
          </Button>
        ) : null}
        <Button type="submit">{editing ? "Save Service" : "Add Service"}</Button>
      </div>
    </form>
  );
}
