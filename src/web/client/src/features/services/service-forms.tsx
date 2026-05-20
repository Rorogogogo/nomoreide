import { FormEvent, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Terminal, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToasts } from "@/components/ui/toast";
import {
  postForm,
  testServiceCommand as testServiceCommandRequest,
  type DashboardData,
  type ServiceTestResult,
} from "@/lib/api";
import { ProcessBadge } from "./process-badge";
import { actionErrorMessage } from "./service-actions";

export function ComposerDialog({
  children,
  icon,
  onClose,
  title,
  size = "md",
}: {
  children: ReactNode;
  icon: ReactNode;
  onClose: () => void;
  title: string;
  size?: "md" | "lg";
}) {
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[1000] grid place-items-center bg-black/35 px-4"
      onMouseDown={onClose}
    >
      <div
        aria-modal="true"
        className={`flex max-h-[min(760px,calc(100vh-2rem))] w-full flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl ${size === "lg" ? "max-w-3xl" : "max-w-lg"}`}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
          <div className="flex size-8 items-center justify-center rounded-md border border-border bg-background text-foreground [&_svg]:size-4">
            {icon}
          </div>
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
          <Button
            aria-label="Close dialog"
            onClick={onClose}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X />
          </Button>
        </div>
        <div className="min-h-0 overflow-auto p-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

const serviceCommandPresets = [
  {
    label: "npm",
    command: "npm run dev",
    description: "Node dev server",
  },
  {
    label: "pnpm",
    command: "pnpm dev",
    description: "pnpm dev server",
  },
  {
    label: "yarn",
    command: "yarn dev",
    description: "Yarn dev server",
  },
  {
    label: "bun",
    command: "bun dev",
    description: "Bun dev server",
  },
  {
    label: "Deno",
    command: "deno task dev",
    description: "Deno dev task",
  },
  {
    label: "Vite",
    badgeCommand: "vite",
    command: "npm run dev -- --host 127.0.0.1",
    description: "Vite app",
  },
  {
    label: "Go",
    command: "go run .",
    description: "Go app",
  },
  {
    label: "Rust",
    command: "cargo run",
    description: "Rust app",
  },
  {
    label: ".NET",
    command: "dotnet watch run",
    description: ".NET app",
  },
  {
    label: "Python",
    command: "python manage.py runserver",
    description: "Python app",
  },
  {
    label: "Docker",
    command: "docker compose up",
    description: "Docker Compose stack",
  },
];

type ServiceKindOption = "local" | "docker-compose" | "ssh";

export function ServiceForm({
  cwd,
  onRefresh,
  onSaved,
}: {
  cwd: string;
  onRefresh: () => Promise<void>;
  onSaved?: () => void;
}) {
  const { error: showErrorToast, success: showSuccessToast } = useToasts();
  const [kind, setKind] = useState<ServiceKindOption>("local");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [formCwd, setFormCwd] = useState(cwd);
  const [port, setPort] = useState("");
  const [description, setDescription] = useState("");
  const [composeFile, setComposeFile] = useState("");
  const [composeService, setComposeService] = useState("");
  const [host, setHost] = useState("");
  const [testResult, setTestResult] = useState<ServiceTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    setTestResult(null);
  }, [command, formCwd, port, kind]);

  function resetForm() {
    setName("");
    setCommand("");
    setFormCwd(cwd);
    setPort("");
    setDescription("");
    setComposeFile("");
    setComposeService("");
    setHost("");
    setTestResult(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const payload: Record<string, string> = {
        name,
        kind,
        cwd: formCwd,
        port,
        description,
      };
      if (kind === "local" || kind === "ssh") payload.command = command;
      if (kind === "docker-compose") {
        payload.composeFile = composeFile;
        payload.composeService = composeService;
      }
      if (kind === "ssh") payload.host = host;

      await postForm("/api/services", payload);
      resetForm();
      showSuccessToast(`${name} added.`);
      await onRefresh();
      onSaved?.();
    } catch (caught) {
      showErrorToast(actionErrorMessage("Add service", name || "service", caught));
    }
  }

  async function testCommand() {
    if (!command.trim()) {
      showErrorToast("Test command failed for service: command is required.");
      return;
    }

    setTesting(true);
    try {
      setTestResult(
        await testServiceCommandRequest({
          command,
          cwd: formCwd,
          port,
        }),
      );
    } catch (caught) {
      showErrorToast(actionErrorMessage("Test command", name || "service", caught));
    } finally {
      setTesting(false);
    }
  }

  const kindOptions: { value: ServiceKindOption; label: string; hint: string }[] = [
    { value: "local", label: "Local", hint: "Run a command in a local working directory." },
    {
      value: "docker-compose",
      label: "Docker Compose",
      hint: "Bring up a service defined in a docker-compose.yml file.",
    },
    {
      value: "ssh",
      label: "SSH (remote)",
      hint: "Run a command on a remote host using your local ~/.ssh/config + ssh-agent.",
    },
  ];
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
              required
              value={name}
            />
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
        <Button type="submit">Add Service</Button>
      </div>
    </form>
  );
}

function ServiceTestAlert({ result }: { result: ServiceTestResult }) {
  const output = [...result.stdout, ...result.stderr].slice(0, 4);

  return (
    <Alert variant={result.ok ? "default" : "destructive"}>
      <div className="font-medium">{result.ok ? "Command test passed" : "Command test failed"}</div>
      <div className="mt-1 text-xs">{result.message}</div>
      {output.length ? (
        <pre className="mt-2 max-h-24 overflow-auto rounded-md bg-background/80 p-2 font-mono text-[11px] leading-4">
          {output.join("\n")}
        </pre>
      ) : null}
    </Alert>
  );
}

export function GroupForm({
  initialName = "",
  initialServices = [],
  onSaved,
  onRefresh,
  originalName,
  services,
  submitLabel = "Save Group",
}: {
  initialName?: string;
  initialServices?: string[];
  onSaved?: () => void;
  onRefresh: () => Promise<void>;
  originalName?: string;
  services: DashboardData["config"]["services"];
  submitLabel?: string;
}) {
  const { error: showErrorToast, success: showSuccessToast } = useToasts();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const name = String(form.get("name") ?? "");
    const selectedServices = form
      .getAll("services")
      .map((service) => String(service))
      .filter(Boolean);
    try {
      await postForm("/api/bundles", {
        name,
        originalName,
        services: selectedServices.join(","),
      });
      formElement.reset();
      showSuccessToast(`${name} group saved.`);
      await onRefresh();
      onSaved?.();
    } catch (caught) {
      showErrorToast(actionErrorMessage("Save group", name || "group", caught));
    }
  }

  return (
    <form className="grid gap-2.5" onSubmit={submit}>
      <Label>
        Group name
        <Input
          className="h-8 text-sm"
          defaultValue={initialName}
          name="name"
          placeholder="full-stack"
          required
        />
      </Label>
      <fieldset className="grid gap-1.5">
        <legend className="text-xs font-medium">Services</legend>
        {services.length ? (
          services.map((service) => (
            <label
              className="flex items-center gap-2 overflow-hidden rounded-md border border-border px-2.5 py-1.5 text-sm"
              key={service.name}
            >
              <input
                className="size-4 shrink-0 accent-primary"
                defaultChecked={initialServices.includes(service.name)}
                name="services"
                type="checkbox"
                value={service.name}
              />
              <ProcessBadge command={service.command ?? ""} compact />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{service.name}</span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                  {service.command ?? service.kind ?? ""}
                </span>
              </span>
            </label>
          ))
        ) : (
          <Alert variant="muted">All services are already grouped, or none registered.</Alert>
        )}
      </fieldset>
      <Button className="h-8" disabled={!services.length} type="submit">
        {submitLabel}
      </Button>
    </form>
  );
}
