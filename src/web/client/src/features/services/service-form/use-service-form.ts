import { FormEvent, useEffect, useState } from "react";
import { useToasts } from "@/components/ui/toast";
import {
  postForm,
  testServiceCommand as testServiceCommandRequest,
  type ServiceTestResult,
} from "@/lib/api";
import { actionErrorMessage } from "../service-actions";
import type { ServiceKindOption } from "./presets";

/**
 * Owns the Add-Service form's field state, the registration submit, and the
 * "test command" probe. The component is left with pure layout.
 */
export function useServiceForm({
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

  return {
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
  };
}
