import { useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Database, Download, GitBranch, Loader2, Play, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToasts } from "@/components/ui/toast";
import { useT } from "@/lib/i18n";
import {
  registerOnboarded,
  scanRepo,
  streamInstall,
  type OnboardDatabaseProposal,
  type OnboardProfile,
  type OnboardProposal,
} from "@/lib/api";
import { ComposerDialog } from "../services/service-form/composer-dialog";
import { useAgentDock } from "../agent/chat/agent-context";

type Step = "url" | "review" | "install";

const CONFIDENCE_VARIANT = {
  high: "success",
  medium: "warning",
  low: "secondary",
} as const;

/**
 * The structured "Add from GitHub" path: paste a URL → review the detected
 * setup → install & start. The clone + scan happen server-side. "Refine with
 * AI" hands the URL to the agent dock (the AI-native path) instead.
 */
export function OnboardDialog({
  onClose,
  onRefresh,
}: {
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  const t = useT();
  const toasts = useToasts();
  const { sendToAgent } = useAgentDock();
  const [step, setStep] = useState<Step>("url");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<OnboardProfile | null>(null);
  const [proposals, setProposals] = useState<OnboardProposal[]>([]);
  const [databases, setDatabases] = useState<OnboardDatabaseProposal[]>([]);
  const [selected, setSelected] = useState<OnboardProposal | null>(null);

  // A docker-compose DB proposal that pairs with the selected service is
  // registered alongside it so the Database tab lights up automatically.
  const matchedDatabase =
    selected?.kind === "docker-compose"
      ? databases.find((db) => db.composeService === selected.composeService)
      : undefined;

  async function handleScan() {
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await scanRepo(url.trim());
      setProfile(result.profile);
      setProposals(result.proposals);
      setDatabases(result.databases);
      setSelected(result.proposals[0] ?? null);
      if (result.proposals.length === 0) {
        setError(t("onboard.scanNoDetect"));
      }
      setStep("review");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  function refineWithAi() {
    sendToAgent({
      prompt: `Onboard this repository and register it as a NoMoreIDE service: ${url.trim()}\nUse nomoreide_onboard_repo to inspect it, pick the best run command, then register and start it.`,
      source: { type: "repo-onboard", label: "Onboard repo" },
      label: t("onboard.refineLabel", { url: url.trim() }),
    });
    onClose();
  }

  async function handleRegister(start: boolean) {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await registerOnboarded(selected, start, matchedDatabase);
      await onRefresh();
      const extras =
        (matchedDatabase ? t("onboard.extraDb") : "") + (start ? t("onboard.extraStart") : "");
      toasts.success(t("onboard.registeredToast", { name: selected.name, extras }));
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ComposerDialog icon={<GitBranch />} onClose={onClose} size="lg" title={t("onboard.title")}>
      {step === "url" ? (
        <UrlStep
          url={url}
          busy={busy}
          error={error}
          onChange={setUrl}
          onScan={handleScan}
          onRefine={refineWithAi}
        />
      ) : null}

      {step === "review" && profile ? (
        <ReviewStep
          profile={profile}
          proposals={proposals}
          selected={selected}
          database={matchedDatabase}
          error={error}
          onSelect={setSelected}
          onEdit={setSelected}
          onBack={() => setStep("url")}
          onRefine={refineWithAi}
          onContinue={() => setStep("install")}
        />
      ) : null}

      {step === "install" && selected ? (
        <InstallStep
          proposal={selected}
          busy={busy}
          error={error}
          onBack={() => setStep("review")}
          onRegister={handleRegister}
        />
      ) : null}
    </ComposerDialog>
  );
}

function UrlStep({
  url,
  busy,
  error,
  onChange,
  onScan,
  onRefine,
}: {
  url: string;
  busy: boolean;
  error: string | null;
  onChange: (value: string) => void;
  onScan: () => void;
  onRefine: () => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{t("onboard.urlIntro")}</p>
      <Input
        autoFocus
        placeholder="https://github.com/owner/repo"
        value={url}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !busy) onScan();
        }}
      />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onRefine} disabled={!url.trim()}>
          <Sparkles className="size-3.5" />
          {t("onboard.refineWithAi")}
        </Button>
        <Button onClick={onScan} disabled={busy || !url.trim()}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <GitBranch className="size-4" />}
          {busy ? t("onboard.cloning") : t("onboard.cloneDetect")}
        </Button>
      </div>
    </div>
  );
}

function ReviewStep({
  profile,
  proposals,
  selected,
  database,
  error,
  onSelect,
  onEdit,
  onBack,
  onRefine,
  onContinue,
}: {
  profile: OnboardProfile;
  proposals: OnboardProposal[];
  selected: OnboardProposal | null;
  database?: OnboardDatabaseProposal;
  error: string | null;
  onSelect: (proposal: OnboardProposal) => void;
  onEdit: (proposal: OnboardProposal) => void;
  onBack: () => void;
  onRefine: () => void;
  onContinue: () => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm font-medium">{profile.name}</span>
        {profile.languages.map((lang) => (
          <Badge key={lang} variant="outline" size="small" label={lang} />
        ))}
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {proposals.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("onboard.detectedServices")}
          </span>
          {proposals.map((proposal) => {
            const active = selected?.name === proposal.name;
            return (
              <button
                key={proposal.name}
                type="button"
                onClick={() => onSelect(proposal)}
                className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                  active ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{proposal.name}</span>
                  <Badge
                    variant={CONFIDENCE_VARIANT[proposal.confidence]}
                    size="small"
                    label={proposal.confidence}
                  />
                </div>
                <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                  {proposal.kind === "docker-compose"
                    ? `compose · ${proposal.composeService}`
                    : proposal.command}
                </div>
                <div className="text-[11px] text-muted-foreground">{proposal.reason}</div>
              </button>
            );
          })}
        </div>
      ) : null}

      {selected ? <ProposalEditor proposal={selected} onChange={onEdit} /> : null}

      {database ? (
        <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-xs text-muted-foreground">
          <Database className="size-3.5" />
          <span>
            {t("onboard.alsoRegistersPre")}{" "}
            <span className="font-medium">{database.name}</span> ({database.engine}){" "}
            {t("onboard.alsoRegistersPost")}
          </span>
        </div>
      ) : null}

      {profile.envKeys.length > 0 ? (
        <div className="text-xs text-muted-foreground">
          <span className="font-medium">{t("onboard.envFrom")}</span> {profile.envKeys.join(", ")}
        </div>
      ) : null}

      {profile.readmeExcerpt ? (
        <details className="rounded-md border border-border bg-muted/30 p-2 text-xs">
          <summary className="cursor-pointer font-medium">{t("onboard.readmeExcerpt")}</summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono">
            {profile.readmeExcerpt}
          </pre>
        </details>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-3.5" />
          {t("common.back")}
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onRefine}>
            <Sparkles className="size-3.5" />
            {t("onboard.refineWithAi")}
          </Button>
          <Button onClick={onContinue} disabled={!selected}>
            {t("onboard.continue")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ProposalEditor({
  proposal,
  onChange,
}: {
  proposal: OnboardProposal;
  onChange: (proposal: OnboardProposal) => void;
}) {
  const t = useT();
  return (
    <div className="grid grid-cols-2 gap-2">
      <Field label={t("onboard.serviceName")}>
        <Input value={proposal.name} onChange={(e) => onChange({ ...proposal, name: e.target.value })} />
      </Field>
      <Field label={t("onboard.portOptional")}>
        <Input
          value={proposal.port?.toString() ?? ""}
          placeholder="auto"
          onChange={(e) =>
            onChange({ ...proposal, port: e.target.value ? Number(e.target.value) : undefined })
          }
        />
      </Field>
      {proposal.kind === "docker-compose" ? (
        <Field label={t("onboard.composeService")} className="col-span-2">
          <Input
            value={proposal.composeService ?? ""}
            onChange={(e) => onChange({ ...proposal, composeService: e.target.value })}
          />
        </Field>
      ) : (
        <Field label={t("onboard.runCommand")} className="col-span-2">
          <Input
            value={proposal.command ?? ""}
            onChange={(e) => onChange({ ...proposal, command: e.target.value })}
          />
        </Field>
      )}
    </div>
  );
}

function InstallStep({
  proposal,
  busy,
  error,
  onBack,
  onRegister,
}: {
  proposal: OnboardProposal;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onRegister: (start: boolean) => void;
}) {
  const t = useT();
  const [installCommand, setInstallCommand] = useState(proposal.installCommand ?? "");
  const [lines, setLines] = useState<string[]>([]);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  function appendLine(text: string) {
    setLines((current) => [...current, text]);
    queueMicrotask(() => {
      const el = logRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  async function runInstall() {
    if (!installCommand.trim()) return;
    setInstalling(true);
    setInstalled(false);
    setLines([]);
    await streamInstall(
      { clonePath: proposal.cwd, command: installCommand.trim() },
      {
        onLine: (line) => appendLine(line.text),
        onDone: (exitCode) => {
          appendLine(
            exitCode === 0
              ? t("onboard.installComplete")
              : t("onboard.installExited", { code: exitCode ?? "?" }),
          );
          setInstalling(false);
          setInstalled(exitCode === 0);
        },
        onError: (message) => {
          appendLine(`✗ ${message}`);
          setInstalling(false);
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end gap-2">
        <Field label={t("onboard.installCommand")} className="flex-1">
          <Input
            value={installCommand}
            placeholder="e.g. npm install"
            onChange={(e) => setInstallCommand(e.target.value)}
          />
        </Field>
        <Button variant="outline" onClick={runInstall} disabled={installing || !installCommand.trim()}>
          {installing ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
          {t("onboard.install")}
        </Button>
      </div>

      {lines.length > 0 ? (
        <pre
          ref={logRef}
          className="max-h-48 overflow-auto rounded-md border border-border bg-black/80 p-2 font-mono text-[11px] text-green-200"
        >
          {lines.join("\n")}
        </pre>
      ) : null}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-3.5" />
          {t("common.back")}
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => onRegister(false)} disabled={busy}>
            {t("onboard.registerOnly")}
          </Button>
          <Button onClick={() => onRegister(true)} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            {installed || !installCommand.trim()
              ? t("onboard.registerStart")
              : t("onboard.skipInstallStart")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-1 text-xs ${className ?? ""}`}>
      <span className="font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
