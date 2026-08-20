import { ChevronRight, Terminal } from "lucide-react";
import type { ReactNode } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { GitRepositoryDefinition, ServiceDefinition } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { SshHostInput } from "@/features/servers/ssh-host-input";
import { ProcessBadge } from "../process-badge";
import { pathInScope } from "../project-scope";
import { kindOptions, serviceCommandPresets } from "./presets";
import { ServiceTestAlert } from "./service-test-alert";
import { useServiceForm } from "./use-service-form";
import { ArgumentsEditor, ServiceEnvEditor } from "./invocation-editors";

export function ServiceForm({
  cwd,
  onRefresh,
  onSaved,
  initialService,
  availableServices = [],
  repositories = [],
}: {
  cwd: string;
  onRefresh: () => Promise<void>;
  onSaved?: () => void;
  initialService?: ServiceDefinition;
  /** Other registered service names, offered as start-order dependencies. */
  availableServices?: string[];
  /** Registered projects a service can be pinned to. */
  repositories?: GitRepositoryDefinition[];
}) {
  const t = useT();
  const {
    editing,
    kind,
    setKind,
    name,
    setName,
    command,
    setCommand,
    directExec,
    setDirectExec,
    args,
    setArgs,
    env,
    setEnv,
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
    dependsOn,
    setDependsOn,
    projectPath,
    setProjectPath,
    testResult,
    testing,
    saving,
    definitionLoading,
    definitionLoadFailed,
    submit,
    testCommand,
  } = useServiceForm({ cwd, onRefresh, onSaved, initialService });

  const activeKindHint =
    kindOptions.find((option) => option.value === kind)?.hint ??
    "services.kind.localHint";
  // Can't depend on itself; everything else registered is fair game.
  const dependencyChoices = availableServices.filter((service) => service !== name);
  // What leaving the select on "inferred" would actually resolve to, so the
  // default option can say so rather than making the user work it out.
  const inferredProject = repositories.find((repository) =>
    pathInScope(formCwd, repository.path),
  );
  const toggleDependency = (service: string) =>
    setDependsOn((current) =>
      current.includes(service)
        ? current.filter((item) => item !== service)
        : [...current, service],
    );
  const canTest = kind === "local" && command.trim().length > 0 && formCwd.trim().length > 0;

  const sectionClass = "grid min-w-0 gap-2 px-3 py-2";
  const legendClass =
    "text-[10px] font-medium uppercase tracking-wide text-muted-foreground";
  const selectedProject = repositories.find(
    (repository) => repository.path === projectPath,
  );

  return (
    <form className="flex h-full min-h-0 flex-col" onSubmit={submit}>
      <div className="min-h-0 flex-1 overflow-auto">
      <fieldset className={`${sectionClass} border-b border-border`}>
        <legend className={legendClass}>{t("services.form.kindSection")}</legend>
        <div className="grid grid-cols-3 gap-1">
          {kindOptions.map((option) => (
            <Button
              className="h-7 justify-center text-[11px]"
              disabled={editing}
              key={option.value}
              onClick={() => setKind(option.value)}
              size="sm"
              type="button"
              variant={kind === option.value ? "default" : "ghost"}
            >
              {t(option.label)}
            </Button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">{t(activeKindHint)}</p>
      </fieldset>

      <div className="grid min-w-0 border-b border-border xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        <fieldset className={sectionClass}>
          <legend className={legendClass}>{t("services.form.detailsSection")}</legend>
          <Label>
            {t("services.form.name")}
            <Input
              className="h-7 text-xs"
              name="name"
              onChange={(event) => setName(event.target.value)}
              placeholder="backend"
              readOnly={editing}
              required
              value={name}
            />
            {editing ? (
              <span className="text-[11px] text-muted-foreground">
                {t("services.form.nameLocked")}
              </span>
            ) : null}
          </Label>
          <Label>
            {t("services.form.description")}
            <Input
              className="h-7 text-xs"
              name="description"
              onChange={(event) => setDescription(event.target.value)}
              placeholder="API server"
              value={description}
            />
          </Label>
          <Label>
            {t("services.form.port")}
            <Input
              className="h-7 font-mono text-xs"
              inputMode="numeric"
              name="port"
              onChange={(event) => setPort(event.target.value)}
              placeholder="3001"
              value={port}
            />
          </Label>
        </fieldset>

        {kind === "local" ? (
          <fieldset className={`${sectionClass} border-t border-border xl:border-l xl:border-t-0`}>
            <legend className={legendClass}>{t("services.form.runSection")}</legend>
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
            {serviceCommandPresets.map((preset) => (
              <Button
                className="h-7 min-w-0 justify-start gap-1.5 px-2 text-[11px]"
                key={preset.label}
                onClick={() => {
                  setCommand(preset.command);
                  setDescription(t(preset.description));
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
            {directExec ? t("services.form.executable") : t("services.form.command")}
            <Input
              className="h-7 font-mono text-xs"
              name="command"
              onChange={(event) => setCommand(event.target.value)}
              placeholder="npm run dev"
              required
              value={command}
            />
          </Label>
          <fieldset
            aria-label={t("services.form.executionMode")}
            className="grid grid-cols-2 gap-0.5 rounded bg-muted/40 p-0.5"
          >
            <Button
              aria-pressed={!directExec}
              className="h-6 text-[11px]"
              onClick={() => setDirectExec(false)}
              size="sm"
              type="button"
              variant={directExec ? "ghost" : "default"}
            >
              {t("services.form.shellCommand")}
            </Button>
            <Button
              aria-pressed={directExec}
              className="h-6 text-[11px]"
              onClick={() => setDirectExec(true)}
              size="sm"
              type="button"
              variant={directExec ? "default" : "ghost"}
            >
              {t("services.form.directExec")}
            </Button>
          </fieldset>
          {directExec ? <ArgumentsEditor args={args} onChange={setArgs} /> : null}
          <Label>
            {t("services.form.cwd")}
            <Input
              className="h-7 font-mono text-xs"
              name="cwd"
              onChange={(event) => setFormCwd(event.target.value)}
              required
              value={formCwd}
            />
          </Label>
          </fieldset>
        ) : null}

        {kind === "docker-compose" ? (
          <fieldset className={`${sectionClass} border-t border-border xl:border-l xl:border-t-0`}>
            <legend className={legendClass}>{t("services.form.runSection")}</legend>
          <Label>
            {t("services.form.composeService")}
            <Input
              className="h-7 font-mono text-xs"
              name="composeService"
              onChange={(event) => setComposeService(event.target.value)}
              placeholder="api"
              required
              value={composeService}
            />
          </Label>
          <Label>
            {t("services.form.composeFile")}
            <Input
              className="h-7 font-mono text-xs"
              name="composeFile"
              onChange={(event) => setComposeFile(event.target.value)}
              placeholder="docker-compose.yml"
              value={composeFile}
            />
          </Label>
          <Label>
            {t("services.form.composeCwd")}
            <Input
              className="h-7 font-mono text-xs"
              name="cwd"
              onChange={(event) => setFormCwd(event.target.value)}
              required
              value={formCwd}
            />
          </Label>
          </fieldset>
        ) : null}

        {kind === "ssh" ? (
          <fieldset className={`${sectionClass} border-t border-border xl:border-l xl:border-t-0`}>
            <legend className={legendClass}>{t("services.form.runSection")}</legend>
          <Label>
            {t("services.form.sshHost")}
            <SshHostInput
              className="h-7 font-mono text-xs"
              name="host"
              onChange={setHost}
              placeholder="devbox"
              required
              value={host}
            />
          </Label>
          <Label>
            {t("services.form.remoteCommand")}
            <Input
              className="h-7 font-mono text-xs"
              name="command"
              onChange={(event) => setCommand(event.target.value)}
              placeholder="npm run dev"
              required
              value={command}
            />
          </Label>
          <Label>
            {t("services.form.remoteCwd")}
            <Input
              className="h-7 font-mono text-xs"
              name="cwd"
              onChange={(event) => setFormCwd(event.target.value)}
              placeholder="/srv/app"
              required
              value={formCwd}
            />
          </Label>
          <Alert variant="muted">
            <div className="font-medium">{t("services.form.sshTitle")}</div>
            <div className="mt-1 text-[11px]">
              {t("services.form.sshBody", { alias: host || "<alias>" })}
            </div>
          </Alert>
          </fieldset>
        ) : null}
      </div>

      {kind === "local" || kind === "ssh" ? (
        <DisclosureSection
          defaultOpen={env.length > 0}
          summary={
            env.length > 0
              ? t("services.form.configuredCount", { count: env.length })
              : t("services.form.noneConfigured")
          }
          title={t("services.form.environmentStep")}
        >
          {definitionLoading ? (
            <p className="text-[10px] text-muted-foreground">
              {t("services.form.loadingDefinition")}
            </p>
          ) : (
            <ServiceEnvEditor entries={env} onChange={setEnv} />
          )}
        </DisclosureSection>
      ) : null}

      {repositories.length > 0 ? (
        <DisclosureSection
          defaultOpen={Boolean(projectPath)}
          summary={
            selectedProject?.name ??
            (inferredProject
              ? t("services.form.projectInferredAs", { name: inferredProject.name })
              : t("services.form.projectInferredNone"))
          }
          title={t("services.form.projectStep")}
        >
          <select
            aria-label={t("services.form.projectLabel")}
            className="h-7 w-full rounded-md border border-border bg-background px-2 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => setProjectPath(event.target.value)}
            value={projectPath}
          >
            <option value="">
              {inferredProject
                ? t("services.form.projectInferredAs", { name: inferredProject.name })
                : t("services.form.projectInferredNone")}
            </option>
            {repositories.map((repository) => (
              <option key={repository.path} value={repository.path}>
                {repository.name}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-muted-foreground">
            {t("services.form.projectHint")}
          </p>
        </DisclosureSection>
      ) : null}

      {dependencyChoices.length > 0 ? (
        <DisclosureSection
          defaultOpen={dependsOn.length > 0}
          summary={
            dependsOn.length > 0
              ? t("services.form.configuredCount", { count: dependsOn.length })
              : t("services.form.noneConfigured")
          }
          title={t("services.form.dependenciesSection")}
        >
          <p className="text-[11px] text-muted-foreground">{t("services.form.depsHint")}</p>
          <div className="flex flex-wrap gap-1.5">
            {dependencyChoices.map((service) => (
              <Button
                className="h-7 px-2.5 font-mono text-[11px]"
                key={service}
                onClick={() => toggleDependency(service)}
                size="sm"
                type="button"
                variant={dependsOn.includes(service) ? "default" : "outline"}
              >
                {service}
              </Button>
            ))}
          </div>
        </DisclosureSection>
      ) : null}

      {testResult ? (
        <div className="px-3 pt-2">
          <ServiceTestAlert result={testResult} />
        </div>
      ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border bg-background px-3 py-2">
        {kind === "local" ? (
          <Button
            className="h-7 text-[11px]"
            disabled={testing || !canTest}
            onClick={testCommand}
            type="button"
            variant="outline"
          >
            <Terminal />
            {testing ? t("services.form.testing") : t("services.form.testCommand")}
          </Button>
        ) : null}
        <Button
          className="h-7 text-[11px]"
          disabled={definitionLoading || definitionLoadFailed}
          loading={saving}
          loadingLabel={t("common.saving")}
          type="submit"
        >
          {editing ? t("services.form.saveService") : t("services.addService")}
        </Button>
      </div>
    </form>
  );
}

function DisclosureSection({
  children,
  defaultOpen,
  summary,
  title,
}: {
  children: ReactNode;
  defaultOpen?: boolean;
  summary: string;
  title: string;
}) {
  return (
    <details className="group border-b border-border" open={defaultOpen || undefined}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 transition-colors hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
        />
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </span>
        <span className="ml-auto min-w-0 truncate text-[10px] text-muted-foreground" title={summary}>
          {summary}
        </span>
      </summary>
      <div className="grid gap-2 px-3 pb-3">{children}</div>
    </details>
  );
}
