import { type FormEvent, useEffect, useState } from "react";
import { useToasts } from "@/components/ui/toast";
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
  const { error: showErrorToast, success: showSuccessToast } = useToasts();
  const editing = Boolean(initialService);
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
      // Joined here; the server splits, trims, and drops self/blank references.
      payload.dependsOn = dependsOn.filter((dep) => dep !== name).join(",");

      await postForm("/api/services", payload);
      if (!editing) resetForm();
      showSuccessToast(editing ? `${name} updated.` : `${name} added.`);
      await onRefresh();
      onSaved?.();
    } catch (caught) {
      showErrorToast(
        actionErrorMessage(editing ? "Update service" : "Add service", name || "service", caught),
      );
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
    testResult,
    testing,
    submit,
    testCommand,
  };
}
