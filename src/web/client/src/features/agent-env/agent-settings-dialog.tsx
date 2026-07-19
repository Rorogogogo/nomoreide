import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Eye, EyeOff, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  getAgentEnvSettings,
  saveAgentEnvSettings,
  setAgentEnvModel,
  type AgentEnvAgentName,
  type AgentEnvSettings,
} from "@/lib/api";
import { AGENT_LABELS } from "./agent-column";
import { useT } from "@/lib/i18n";
import { maskSecrets } from "./mask-secrets";

/** Datalist hints only — free text is always allowed so the list can't go stale. */
const MODEL_SUGGESTIONS: Record<AgentEnvAgentName, string[]> = {
  claude: ["opus", "sonnet", "haiku", "opusplan"],
  codex: ["gpt-5-codex", "gpt-5"],
  antigravity: [],
};

/**
 * Guarded editor for an agent's settings file: a curated model switch on top,
 * the raw file below. Every save validates (JSON/TOML) server-side and writes
 * a timestamped `.bak` sibling first, so a bad edit can't brick the agent.
 */
export function AgentSettingsDialog({
  agent,
  onClose,
}: {
  agent: AgentEnvAgentName;
  onClose: () => void;
}) {
  const t = useT();
  const [settings, setSettings] = useState<AgentEnvSettings | null>(null);
  const [content, setContent] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getAgentEnvSettings(agent)
      .then((loaded) => {
        if (cancelled || !loaded) return;
        setSettings(loaded);
        setContent(loaded.content);
        setModel(loaded.model ?? "");
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [agent]);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, busy]);

  const dirty = settings !== null && content !== settings.content;
  // Secret values are masked for display only; while masked the editor is
  // read-only so the mask can never be saved back into the file.
  const masked = maskSecrets(content);
  const showMasked = !revealed && masked !== content;
  const modelDirty = settings !== null && model.trim() !== (settings.model ?? "");

  const applyModel = async () => {
    setBusy(true);
    setError(null);
    try {
      const { settings: updated } = await setAgentEnvModel(agent, model);
      setSettings(updated);
      setContent(updated.content);
      setModel(updated.model ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const saveFile = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveAgentEnvSettings(agent, content);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: click-to-dismiss backdrop; Escape also cancels.
    <div
      className="fixed inset-0 z-[1000] grid place-items-center bg-black/35 px-4"
      onMouseDown={() => !busy && onClose()}
    >
      <div
        aria-modal="true"
        className="flex w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="space-y-3 px-4 py-4">
          <div className="flex items-start gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground [&_svg]:size-4">
              <Settings2 />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold">{t("agentEnv.settingsTitle", { name: AGENT_LABELS[agent] })}</h2>
              <p className="truncate font-mono text-[11px] text-muted-foreground" title={settings?.path}>
                {settings?.path ?? t("agentEnv.settings.loading")}
              </p>
            </div>
          </div>

          {settings?.modelEditable ? (
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium" htmlFor={`model-${agent}`}>
                {t("agentEnv.settings.model")}
              </label>
              <input
                className="h-8 w-56 rounded-md border border-border bg-background px-2 font-mono text-xs"
                disabled={busy || !settings}
                id={`model-${agent}`}
                list={`model-suggestions-${agent}`}
                onChange={(event) => setModel(event.target.value)}
                placeholder={t("agentEnv.settings.modelPlaceholder")}
                value={model}
              />
              <datalist id={`model-suggestions-${agent}`}>
                {MODEL_SUGGESTIONS[agent].map((suggestion) => (
                  <option key={suggestion} value={suggestion} />
                ))}
              </datalist>
              <Button
                disabled={busy || !modelDirty || dirty}
                onClick={() => void applyModel()}
                size="sm"
                title={dirty ? t("agentEnv.settings.applyBlocked") : undefined}
                variant="outline"
              >
                {t("agentEnv.settings.apply")}
              </Button>
            </div>
          ) : null}

          <div className="relative">
            <textarea
              aria-label={t("agentEnv.settings.contentAria")}
              className="h-72 w-full resize-y rounded-md border border-border bg-background p-2 font-mono text-xs leading-relaxed focus:outline-none"
              disabled={busy || !settings}
              onChange={(event) => !showMasked && setContent(event.target.value)}
              placeholder={
                settings && !settings.exists
                  ? t("agentEnv.settings.missingFile")
                  : undefined
              }
              readOnly={showMasked}
              spellCheck={false}
              value={showMasked ? masked : content}
            />
            {masked !== content || revealed ? (
              <Button
                className="absolute right-2 top-2 h-7 gap-1.5 px-2 text-[11px] text-muted-foreground"
                onClick={() => setRevealed((current) => !current)}
                size="sm"
                title={showMasked ? t("agentEnv.settings.revealTitle") : t("agentEnv.settings.hideTitle")}
                type="button"
                variant="ghost"
              >
                {showMasked ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                {showMasked ? t("agentEnv.settings.reveal") : t("agentEnv.settings.hide")}
              </Button>
            ) : null}
          </div>

          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <p className="text-[11px] text-muted-foreground">
            {t("agentEnv.settings.footnote", { format: settings?.format === "toml" ? "TOML" : "JSON" })}
          </p>
        </div>

        <div className="flex justify-end gap-2 border-t border-border bg-muted/30 px-4 py-3">
          <Button disabled={busy} onClick={onClose} size="sm" type="button" variant="outline">
            {t("agentEnv.settings.close")}
          </Button>
          <Button
            disabled={busy || !dirty}
            onClick={() => void saveFile()}
            size="sm"
            type="button"
          >
            {busy ? t("agentEnv.settings.savingFile") : t("agentEnv.settings.saveFile")}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
