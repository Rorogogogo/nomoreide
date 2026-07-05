import { Bot, Check, Languages, Palette, Moon, Sun, Terminal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAgentDock } from "@/features/agent/chat/agent-context";
import { useTheme, type Theme } from "@/lib/theme";
import { LANGUAGE_OPTIONS } from "@/lib/language";
import { useLanguage, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const THEME_OPTIONS: { value: Theme; labelKey: "settings.theme.light" | "settings.theme.dark"; icon: typeof Sun }[] = [
  { value: "light", labelKey: "settings.theme.light", icon: Sun },
  { value: "dark", labelKey: "settings.theme.dark", icon: Moon },
];

/** Reused row shell for every selectable option in Settings. */
function OptionRow({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-3 rounded-md border px-4 py-3 text-left text-sm transition-colors",
        active ? "border-primary bg-primary/10 text-foreground" : "border-border hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}

export function SettingsView() {
  const t = useT();
  const [theme, setTheme] = useTheme();
  const [language, setLanguage] = useLanguage();
  const { provider, providers, selectProvider } = useAgentDock();

  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Palette className="size-4 text-muted-foreground" />
              {t("settings.appearance.title")}
            </CardTitle>
            <CardDescription>{t("settings.appearance.desc")}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3">
              {THEME_OPTIONS.map(({ value, labelKey, icon: Icon }) => {
                const active = theme === value;
                return (
                  <OptionRow key={value} active={active} onClick={() => setTheme(value)}>
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="flex-1 font-medium">{t(labelKey)}</span>
                    {active ? <Check className="size-4 shrink-0 text-primary" /> : null}
                  </OptionRow>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Languages className="size-4 text-muted-foreground" />
              {t("settings.language.title")}
            </CardTitle>
            <CardDescription>{t("settings.language.desc")}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-3">
              {LANGUAGE_OPTIONS.map((option) => {
                const active = language === option.value;
                return (
                  <OptionRow
                    key={option.value}
                    active={active}
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
                      <Badge variant="outline" size="small">
                        {t("settings.comingSoon")}
                      </Badge>
                    ) : null}
                    {active ? <Check className="size-4 shrink-0 text-primary" /> : null}
                  </OptionRow>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bot className="size-4 text-muted-foreground" />
              {t("settings.agent.title")}
            </CardTitle>
            <CardDescription>{t("settings.agent.desc")}</CardDescription>
          </CardHeader>
          <CardContent>
            {providers.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("settings.agent.loading")}</p>
            ) : (
              <div className="flex flex-col gap-3">
                {providers.map((option) => {
                  const active = provider?.id === option.id;
                  return (
                    <OptionRow
                      key={option.id}
                      active={active}
                      onClick={() => {
                        if (!active) void selectProvider(option.id);
                      }}
                    >
                      <Terminal className="size-4 shrink-0 text-muted-foreground" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="font-medium">{option.label}</span>
                        <span className="truncate font-mono text-xs text-muted-foreground">
                          {option.commandName}
                          {!option.configured ? ` — ${option.installHint}` : ""}
                        </span>
                      </span>
                      {!option.configured ? (
                        <Badge variant="outline" size="small">
                          {t("settings.agent.notInstalled")}
                        </Badge>
                      ) : null}
                      {active ? (
                        <Badge variant="success" size="small">
                          {t("settings.agent.active")}
                        </Badge>
                      ) : null}
                    </OptionRow>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
