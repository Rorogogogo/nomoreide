import { type FormEvent, useEffect, useState } from "react";
import { useToasts } from "@/components/ui/toast";
import { useOperations } from "@/components/operations/operation-context";
import { useT } from "@/lib/i18n";
import {
  getServiceDefinition,
  registerService,
  testServiceCommand as testServiceCommandRequest,
  type ServiceDefinition,
  type ServiceTestResult,
} from "@/lib/api";
import { actionErrorMessage } from "../service-actions";
import type { ServiceKindOption } from "./presets";

/**
 * Owns the service composer's field state, the registration submit, and the
 * "test command" probe. The component is left with pure layout. Passing
 * `initialService` switches the form into edit mode (prefilled, saves over the
 * existing definition since registration replaces by name).
 */
export function useServiceForm({
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
  const t = useT();
  const { error: showErrorToast, success: showSuccessToast } = useToasts();
  const { isPending, runOperation } = useOperations();
  const editing = Boolean(initialService);
  const operationKey = `service-form:${initialService?.name ?? "new"}:save`;
  const saving = isPending(operationKey);
  const [kind, setKind] = useState<ServiceKindOption>(initialService?.kind ?? "local");
  const [name, setName] = useState(initialService?.name ?? "");
  const [command, setCommand] = useState(initialService?.command ?? "");
  const [directExec, setDirectExec] = useState(initialService?.args !== undefined);
  const [args, setArgs] = useState<string[]>(initialService?.args ?? []);
  const [env, setEnv] = useState<Array<{ key: string; value: string }>>(
    Object.entries(initialService?.env ?? {}).map(([key, value]) => ({ key, value })),
  );
  const [definitionLoading, setDefinitionLoading] = useState(Boolean(initialService));
  const [definitionLoadFailed, setDefinitionLoadFailed] = useState(false);
  const [formCwd, setFormCwd] = useState(initialService?.cwd ?? cwd);
  const [port, setPort] = useState(initialService?.port ? String(initialService.port) : "");
  const [description, setDescription] = useState(initialService?.description ?? "");
  const [composeFile, setComposeFile] = useState(initialService?.composeFile ?? "");
  const [composeService, setComposeService] = useState(initialService?.composeService ?? "");
  const [host, setHost] = useState(initialService?.host ?? "");
  const [dependsOn, setDependsOn] = useState<string[]>(initialService?.dependsOn ?? []);
  // "" means infer the project from cwd — the default for local services.
  const [projectPath, setProjectPath] = useState(initialService?.projectPath ?? "");
  const [testResult, setTestResult] = useState<ServiceTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (!initialService) return;
    let cancelled = false;
    setDefinitionLoading(true);
    setDefinitionLoadFailed(false);
    void getServiceDefinition(initialService.name)
      .then((service) => {
        if (cancelled) return;
        setDirectExec(service.args !== undefined);
        setArgs(service.args ?? []);
        setEnv(
          Object.entries(service.env ?? {}).map(([key, value]) => ({ key, value })),
        );
      })
      .catch((caught) => {
        if (cancelled) return;
        setDefinitionLoadFailed(true);
        showErrorToast(
          actionErrorMessage(
            t,
            t("services.actions.loadService"),
            initialService.name,
            caught,
          ),
        );
      })
      .finally(() => {
        if (!cancelled) setDefinitionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initialService?.name, showErrorToast, t]);

  useEffect(() => {
    setTestResult(null);
  }, [command, args, directExec, env, formCwd, port, kind]);

  function resetForm() {
    setName("");
    setCommand("");
    setDirectExec(false);
    setArgs([]);
    setEnv([]);
    setFormCwd(cwd);
    setPort("");
    setDescription("");
    setComposeFile("");
    setComposeService("");
    setHost("");
    setDependsOn([]);
    setProjectPath("");
    setTestResult(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (definitionLoading || definitionLoadFailed) return;
    const envKeys = env.map((entry) => entry.key);
    if (new Set(envKeys).size !== envKeys.length) {
      showErrorToast(t("services.form.duplicateVariable"));
      return;
    }
    try {
      await runOperation(
        {
          key: operationKey,
          label: t("services.actions.saving", {
            name: name || t("services.actions.serviceFallback"),
          }),
        },
        async () => {
          const definition: ServiceDefinition = {
            name,
            kind,
            cwd: formCwd,
            description,
            ...(port ? { port: Number(port) } : {}),
            dependsOn: dependsOn.filter((dep) => dep !== name),
            ...(projectPath ? { projectPath } : {}),
          };
          if (kind === "local" || kind === "ssh") definition.command = command;
          if (kind === "local" && directExec) definition.args = args;
          if (kind === "local" || kind === "ssh") {
            definition.env = Object.fromEntries(
              env.map((entry) => [entry.key, entry.value]),
            );
          }
          if (kind === "docker-compose") {
            definition.composeFile = composeFile;
            definition.composeService = composeService;
          }
          if (kind === "ssh") definition.host = host;

          await registerService(definition);
          if (!editing) resetForm();
          showSuccessToast(
            editing
              ? t("services.actions.updated", { name })
              : t("services.actions.added", { name }),
          );
          await onRefresh();
          onSaved?.();
        },
      );
    } catch (caught) {
      showErrorToast(
        actionErrorMessage(
          t,
          editing ? t("services.actions.updateService") : t("services.actions.addService"),
          name || t("services.actions.serviceFallback"),
          caught,
        ),
      );
    }
  }

  async function testCommand() {
    if (!command.trim()) {
      showErrorToast(
        t("services.actions.failed", {
          label: t("services.actions.testCommand"),
          target: t("services.actions.serviceFallback"),
          message: t("services.actions.commandRequired"),
        }),
      );
      return;
    }

    setTesting(true);
    try {
      setTestResult(
        await testServiceCommandRequest({
          command,
          ...(directExec ? { args: JSON.stringify(args) } : {}),
          env: JSON.stringify(Object.fromEntries(env.map((entry) => [entry.key, entry.value]))),
          cwd: formCwd,
          port,
        }),
      );
    } catch (caught) {
      showErrorToast(
        actionErrorMessage(
          t,
          t("services.actions.testCommand"),
          name || t("services.actions.serviceFallback"),
          caught,
        ),
      );
    } finally {
      setTesting(false);
    }
  }

  return {
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
  };
}
