import type { ReactNode } from "react";
import {
  BookOpen,
  Check,
  Info,
  Languages,
  Moon,
  Palette,
  Settings,
  Sun,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { LANGUAGE_OPTIONS, useLanguage } from "@/lib/language";
import { useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const THEME_OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

/** Reused row shell for every selectable option in Settings. */
function OptionRow({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        "flex items-center gap-2.5 rounded-md border px-3 py-2 text-left text-sm transition-colors",
        active ? "border-primary bg-primary/10 text-foreground" : "border-border hover:bg-muted",
      )}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function Section({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-border/60 px-4 py-4 last:border-b-0">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        {icon}
        {title}
      </h2>
      <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function SettingsView() {
  const [theme, setTheme] = useTheme();
  const [language, setLanguage] = useLanguage();

  return (
    <div className="flex h-full min-h-0 flex-col bg-card/85">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Settings className="size-4 text-muted-foreground" />
        <span className="text-sm font-semibold">Settings</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-xl">
          <Section
            description="Theme for the dashboard. The header toggle switches the same setting."
            icon={<Palette className="size-4 text-muted-foreground" />}
            title="Appearance"
          >
            <div className="grid grid-cols-2 gap-2">
              {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
                const active = theme === value;
                return (
                  <OptionRow active={active} key={value} onClick={() => setTheme(value)}>
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="flex-1 font-medium">{label}</span>
                    {active ? <Check className="size-4 shrink-0 text-primary" /> : null}
                  </OptionRow>
                );
              })}
            </div>
          </Section>

          <Section
            description="Your preference is saved now; the interface switches once the translation catalogs land."
            icon={<Languages className="size-4 text-muted-foreground" />}
            title="Language"
          >
            <div className="flex flex-col gap-2">
              {LANGUAGE_OPTIONS.map((option) => {
                const active = language === option.value;
                return (
                  <OptionRow
                    active={active}
                    key={option.value}
                    onClick={() => setLanguage(option.value)}
                  >
                    <span className="flex-1">
                      <span className="font-medium">{option.nativeLabel}</span>
                      {option.nativeLabel !== option.englishLabel ? (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {option.englishLabel}
                        </span>
                      ) : null}
                    </span>
                    {!option.available ? (
                      <Badge size="small" variant="outline">
                        Coming soon
                      </Badge>
                    ) : null}
                    {active ? <Check className="size-4 shrink-0 text-primary" /> : null}
                  </OptionRow>
                );
              })}
            </div>
          </Section>

          <Section
            description="This local console and where to learn more."
            icon={<Info className="size-4 text-muted-foreground" />}
            title="About"
          >
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
              <dt className="text-muted-foreground">Version</dt>
              <dd className="font-mono">v{__APP_VERSION__}</dd>
              <dt className="text-muted-foreground">Console</dt>
              <dd className="font-mono">127.0.0.1:4317</dd>
              <dt className="text-muted-foreground">Docs</dt>
              <dd>
                <a
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                  href="https://www.nomoreide.com/docs"
                  rel="noreferrer"
                  target="_blank"
                >
                  <BookOpen className="size-3" />
                  nomoreide.com/docs
                </a>
              </dd>
            </dl>
          </Section>
        </div>
      </div>
    </div>
  );
}
