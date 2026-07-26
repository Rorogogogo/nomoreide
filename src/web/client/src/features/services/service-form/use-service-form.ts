import { type FormEvent, useEffect, useState } from "react";
import { useToasts } from "@/components/ui/toast";
import { useOperations } from "@/components/operations/operation-context";
import { useT } from "@/lib/i18n";
import {
  postForm,
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
    setDependsOn([]);
    setProjectPath("");
    setTestResult(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await runOperation(
        {
          key: operationKey,
          label: t("services.actions.saving", {
            name: name || t("services.actions.serviceFallback"),
          }),
        },
        async () => {
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
          // Joined here; the server splits, trims, and drops self/blank references.
          payload.dependsOn = dependsOn.filter((dep) => dep !== name).join(",");
          // Blank is meaningful: it clears an assignment back to cwd inference.
          payload.projectPath = projectPath;

          await postForm("/api/services", payload);
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
    submit,
    testCommand,
  };
}
