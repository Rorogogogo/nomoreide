import { Terminal } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ServiceDefinition } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { ProcessBadge } from "../process-badge";
import { kindOptions, serviceCommandPresets } from "./presets";
import { ServiceTestAlert } from "./service-test-alert";
import { useServiceForm } from "./use-service-form";

export function ServiceForm({
  cwd,
  onRefresh,
  onSaved,
  initialService,
  availableServices = [],
}: {
  cwd: string;
  onRefresh: () => Promise<void>;
  onSaved?: () => void;
  initialService?: ServiceDefinition;
  /** Other registered service names, offered as start-order dependencies. */
  availableServices?: string[];
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
    testResult,
    testing,
    saving,
    submit,
    testCommand,
  } = useServiceForm({ cwd, onRefresh, onSaved, initialService });

  const activeKind = kindOptions.find((option) => option.value === kind)!;
  // Can't depend on itself; everything else registered is fair game.
  const dependencyChoices = availableServices.filter((service) => service !== name);
  const toggleDependency = (service: string) =>
    setDependsOn((current) =>
      current.includes(service)
        ? current.filter((item) => item !== service)
        : [...current, service],
    );
  const canTest = kind === "local" && command.trim().length > 0 && formCwd.trim().length > 0;

  const sectionClass =
    "grid gap-2 rounded-md border border-border bg-muted/30 p-3";
  const legendClass =
    "px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";

  return (
    <form className="grid gap-3" onSubmit={submit}>
      <div className="grid gap-3 sm:grid-cols-2">
      <fieldset className={`${sectionClass} sm:col-span-2`}>
        <legend className={legendClass}>{t("services.form.step1")}</legend>
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
              {t(option.label)}
            </Button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">{t(activeKind.hint)}</p>
      </fieldset>

      <div className="grid gap-3 sm:col-start-1 sm:row-start-2 sm:self-start">
        <fieldset className={sectionClass}>
          <legend className={legendClass}>{t("services.form.step2")}</legend>
          <Label>
            {t("services.form.name")}
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
                {t("services.form.nameLocked")}
              </span>
            ) : null}
          </Label>
          <Label>
            {t("services.form.description")}
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
          <legend className={legendClass}>{t("services.form.step4")}</legend>
          <Label>
            {t("services.form.port")}
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
          <legend className={legendClass}>{t("services.form.step3Local")}</legend>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {serviceCommandPresets.map((preset) => (
              <Button
                className="justify-start gap-1.5"
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
            {t("services.form.command")}
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
            {t("services.form.cwd")}
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
          <legend className={legendClass}>{t("services.form.step3Compose")}</legend>
          <Label>
            {t("services.form.composeService")}
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
            {t("services.form.composeFile")}
            <Input
              className="h-8 font-mono text-sm"
              name="composeFile"
              onChange={(event) => setComposeFile(event.target.value)}
              placeholder="docker-compose.yml"
              value={composeFile}
            />
          </Label>
          <Label>
            {t("services.form.composeCwd")}
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
          <legend className={legendClass}>{t("services.form.step3Ssh")}</legend>
          <Label>
            {t("services.form.sshHost")}
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
            {t("services.form.remoteCommand")}
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
            {t("services.form.remoteCwd")}
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
            <div className="font-medium">{t("services.form.sshTitle")}</div>
            <div className="mt-1 text-xs">
              {t("services.form.sshBody", { alias: host || "<alias>" })}
            </div>
          </Alert>
        </fieldset>
      ) : null}

      {dependencyChoices.length > 0 ? (
        <fieldset className={`${sectionClass} sm:col-span-2`}>
          <legend className={legendClass}>{t("services.form.step5")}</legend>
          <p className="text-[11px] text-muted-foreground">{t("services.form.depsHint")}</p>
          <div className="flex flex-wrap gap-1.5">
            {dependencyChoices.map((service) => (
              <Button
                className="h-7 px-2.5 text-xs"
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
            {testing ? t("services.form.testing") : t("services.form.testCommand")}
          </Button>
        ) : null}
        <Button
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
