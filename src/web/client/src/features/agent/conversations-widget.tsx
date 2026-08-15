import { MessagesSquare } from "lucide-react";
import {
  WidgetMore,
  WidgetNote,
  WidgetRow,
  WidgetRows,
  WidgetStat,
  WidgetStats,
} from "@/features/home/widget-grid";
import type { WidgetDefinition } from "@/features/home/widget-types";
import { useT } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/utils";
import { ClaudeLogo, CodexLogo } from "./agent-logos";
import { useHomeConversationSummary } from "./use-home-conversation-summary";

/**
 * Conversations — what you were last doing with an agent, ready to pick up.
 *
 * The Agent widget beside it reports whether the AI half is *working*; this one
 * reports what it was *for*. Resuming is the one thing you come back to a
 * workbench to do and, until now, Home said nothing about it — you had to open
 * the Agent page and reveal the history rail to find out what was there.
 *
 * **The widget advertises; the page resumes.** A widget panel is a single
 * `<button>` (see `WidgetPanel`), so it cannot carry a resume control per row —
 * nested interactive elements are invalid and unreachable by keyboard. That is
 * the right split anyway: a per-row resume button here would be a second,
 * drifting implementation of the rail that already does it properly.
 *
 * It shipped full-width, on the theory that prose wants the room, and that was
 * wrong on a wide monitor: `core/agent-transcripts.ts` caps a title at 200
 * characters, so past about 900px the row is title, a long gap, and a
 * timestamp against the far edge. Half width fits the longest title there is.
 * The width is only a default now — see `home-layout.ts` — but a default is
 * what most people will keep.
 */
export const conversationsWidget: WidgetDefinition = {
  id: "conversations",
  titleKey: "home.widget.conversations",
  icon: <MessagesSquare />,
  span: 6,
  scope: "repo",
  source: "fetch",
  page: "agent",
  render: () => <ConversationSummary />,
};

/**
 * Five, not the four everything else shows.
 *
 * On the other panels the rows are a sample of a page you go to for the rest;
 * here the list *is* what was asked for, so it gets one more line than a
 * sample would.
 */
const ROW_CAP = 5;

/** Brand names, identical in every language — no translation key to miss. */
const PROVIDER_LABEL: Record<"claude" | "codex", string> = {
  claude: "Claude",
  codex: "Codex",
};

function ConversationSummary() {
  const t = useT();
  const { conversations, loaded, today, total } = useHomeConversationSummary();

  return (
    <>
      <WidgetStats>
        <WidgetStat label={t("home.conversations.today")} pending={!loaded} value={today} />
        <WidgetStat label={t("home.conversations.total")} pending={!loaded} value={total} />
      </WidgetStats>
      {conversations.length === 0 ? (
        loaded ? (
          <WidgetNote>{t("home.conversations.none")}</WidgetNote>
        ) : null
      ) : (
        <WidgetRows>
          {conversations.slice(0, ROW_CAP).map((conversation) => (
            <WidgetRow
              key={conversation.id}
              /*
                A real provider mark, not a generic glyph: these two are the
                only agents a transcript can come from, both marks are already
                in the tree, and at 12px the difference between them is legible
                where a dot's colour would not be. The rule in
                `features/deploy/provider-logo.tsx` still holds for everything
                else — it forbids *half-remembered* logos, not ones we have.
              */
              mark={
                <>
                  {conversation.provider === "codex" ? <CodexLogo /> : <ClaudeLogo />}
                  <span className="sr-only">{PROVIDER_LABEL[conversation.provider]}</span>
                </>
              }
              /*
                The title is the subject, so it takes the prose cell and the row
                leaves `name` empty — a transcript's id is a uuid. Titles are
                the user's own typed prompt, already collapsed and cut to 200
                characters by `core/agent-transcripts.ts`, and truncated again
                to whatever the panel is wide.
              */
              meta={conversation.title}
              trailing={formatRelativeTime(conversation.updatedAt)}
            />
          ))}
          {conversations.length > ROW_CAP ? (
            <WidgetMore>{t("home.more", { count: conversations.length - ROW_CAP })}</WidgetMore>
          ) : null}
        </WidgetRows>
      )}
    </>
  );
}
