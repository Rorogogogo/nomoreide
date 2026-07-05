import type { FormEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToasts } from "@/components/ui/toast";
import { useT } from "@/lib/i18n";
import { postForm, type DashboardData } from "@/lib/api";
import { ProcessBadge } from "../process-badge";
import { actionErrorMessage } from "../service-actions";

export function GroupForm({
  initialName = "",
  initialServices = [],
  onSaved,
  onRefresh,
  originalName,
  services,
  submitLabel,
}: {
  initialName?: string;
  initialServices?: string[];
  onSaved?: () => void;
  onRefresh: () => Promise<void>;
  originalName?: string;
  services: DashboardData["config"]["services"];
  submitLabel?: string;
}) {
  const t = useT();
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
      showSuccessToast(t("services.group.savedToast", { name }));
      await onRefresh();
      onSaved?.();
    } catch (caught) {
      showErrorToast(
        actionErrorMessage(
          t,
          t("services.group.saveGroup"),
          name || t("services.actions.groupFallback"),
          caught,
        ),
      );
    }
  }

  return (
    <form className="grid gap-2.5" onSubmit={submit}>
      <Label>
        {t("services.group.name")}
        <Input
          className="h-8 text-sm"
          defaultValue={initialName}
          name="name"
          placeholder="full-stack"
          required
        />
      </Label>
      <fieldset className="grid gap-1.5">
        <legend className="text-xs font-medium">{t("services.group.services")}</legend>
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
          <Alert variant="muted">{t("services.group.allGrouped")}</Alert>
        )}
      </fieldset>
      <Button className="h-8" disabled={!services.length} type="submit">
        {submitLabel ?? t("services.group.saveGroup")}
      </Button>
    </form>
  );
}
