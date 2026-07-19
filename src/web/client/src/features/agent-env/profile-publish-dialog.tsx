import { useState } from "react";
import { UploadCloud } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { PublishFormInput } from "./use-registry";
import { useT } from "@/lib/i18n";

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9.-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

/** Publish a saved profile to the hosted registry (slug/title/version form). */
export function ProfilePublishDialog({
  profileName,
  busy,
  onConfirm,
  onCancel,
}: {
  profileName: string;
  busy: boolean;
  onConfirm: (input: PublishFormInput) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [slug, setSlug] = useState(slugify(profileName));
  const [title, setTitle] = useState(profileName);
  const [version, setVersion] = useState("1.0.0");
  const [summary, setSummary] = useState("");

  const valid = slug.trim().length > 0 && title.trim().length > 0;
  const fieldClass =
    "h-8 w-full rounded-md border border-border bg-background px-2 text-xs";

  return (
    <ConfirmDialog
      confirmLabel={busy ? t("agentEnv.publishing") : t("agentEnv.publish")}
      icon={<UploadCloud />}
      loading={busy}
      message={
        <div className="space-y-2">
          <p>
            {t("agentEnv.publishBodyPre")}
            <span className="font-medium text-foreground">{profileName}</span>
            {t("agentEnv.publishBodyPost")}
          </p>
          <label className="block space-y-1">
            <span className="text-[11px] font-medium">{t("agentEnv.slugField")}</span>
            <input
              className={fieldClass}
              onChange={(event) => setSlug(slugify(event.target.value))}
              value={slug}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] font-medium">{t("agentEnv.titleField")}</span>
            <input
              className={fieldClass}
              onChange={(event) => setTitle(event.target.value)}
              value={title}
            />
          </label>
          <div className="flex gap-2">
            <label className="block w-24 space-y-1">
              <span className="text-[11px] font-medium">{t("agentEnv.versionField")}</span>
              <input
                className={fieldClass}
                onChange={(event) => setVersion(event.target.value)}
                value={version}
              />
            </label>
            <label className="block flex-1 space-y-1">
              <span className="text-[11px] font-medium">{t("agentEnv.summaryField")}</span>
              <input
                className={fieldClass}
                onChange={(event) => setSummary(event.target.value)}
                value={summary}
              />
            </label>
          </div>
        </div>
      }
      onCancel={onCancel}
      onConfirm={() => {
        if (!valid || busy) return;
        onConfirm({
          name: profileName,
          slug: slug.trim(),
          title: title.trim(),
          version: version.trim() || undefined,
          summary: summary.trim() || undefined,
        });
      }}
      title={t("agentEnv.publishTitle")}
      tone="success"
    />
  );
}
