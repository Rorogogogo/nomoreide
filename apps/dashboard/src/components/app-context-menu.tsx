import {
  Bot,
  Clipboard,
  ClipboardPaste,
  Copy,
  RefreshCw,
  Scissors,
  SendHorizontal,
} from "lucide-react";
import { type PointerEvent as ReactPointerEvent, type ReactElement, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useToasts } from "@/components/ui/toast";
import {
  type AiContextIntent,
  type AiContextTargetDescriptor,
  useOptionalAiContextMenuRegistry,
} from "@/features/agent/context-menu/ai-context-menu";
import { useOptionalAgentDock } from "@/features/agent/chat/agent-context";
import { useT } from "@/lib/i18n";

type TextControl = HTMLInputElement | HTMLTextAreaElement;

type ContextTarget =
  | {
      kind: "control";
      element: TextControl;
      start: number;
      end: number;
      selectedText: string;
      editable: boolean;
    }
  | {
      kind: "contenteditable";
      element: HTMLElement;
      range: Range | null;
      selectedText: string;
      editable: boolean;
    }
  | {
      kind: "page";
      selectedText: string;
      editable: false;
    };

const TEXT_INPUT_TYPES = new Set(["email", "password", "search", "tel", "text", "url"]);

function resolveContextTarget(target: EventTarget | null): ContextTarget {
  if (target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type)) {
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? start;
    return {
      kind: "control",
      element: target,
      start,
      end,
      selectedText: target.value.slice(start, end),
      editable: !target.disabled && !target.readOnly,
    };
  }

  if (target instanceof HTMLTextAreaElement) {
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? start;
    return {
      kind: "control",
      element: target,
      start,
      end,
      selectedText: target.value.slice(start, end),
      editable: !target.disabled && !target.readOnly,
    };
  }

  const element = target instanceof Element ? target.closest<HTMLElement>("[contenteditable=true]") : null;
  if (element) {
    const selection = window.getSelection();
    const range =
      selection && selection.rangeCount > 0 && element.contains(selection.anchorNode)
        ? selection.getRangeAt(0).cloneRange()
        : null;
    return {
      kind: "contenteditable",
      element,
      range,
      selectedText: range?.toString() ?? "",
      editable: true,
    };
  }

  return {
    kind: "page",
    selectedText: window.getSelection()?.toString() ?? "",
    editable: false,
  };
}

function restoreContentEditableSelection(target: Extract<ContextTarget, { kind: "contenteditable" }>) {
  target.element.focus();
  if (!target.range) return;
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(target.range);
}

function selectAll(target: ContextTarget) {
  if (target.kind === "control") {
    target.element.focus();
    target.element.select();
    return;
  }
  if (target.kind === "contenteditable") {
    target.element.focus();
    const range = document.createRange();
    range.selectNodeContents(target.element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
}

function replaceSelection(target: ContextTarget, text: string) {
  if (target.kind === "control") {
    target.element.focus();
    target.element.setRangeText(text, target.start, target.end, "end");
    target.element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    return;
  }
  if (target.kind === "contenteditable") {
    restoreContentEditableSelection(target);
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const textNode = document.createTextNode(text);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    target.element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }
}

export function AppContextMenu({
  children,
  onRefresh,
}: {
  children: ReactElement;
  onRefresh: () => void;
}) {
  const t = useT();
  const registry = useOptionalAiContextMenuRegistry();
  const agentDock = useOptionalAgentDock();
  const { error: showError, success: showSuccess } = useToasts();
  const targetRef = useRef<ContextTarget>({ kind: "page", selectedText: "", editable: false });
  const cursorBadgeRef = useRef<HTMLDivElement>(null);
  const [capabilities, setCapabilities] = useState<{
    canCopy: boolean;
    canEdit: boolean;
    aiTarget: AiContextTargetDescriptor | null;
  }>({ canCopy: false, canEdit: false, aiTarget: null });

  function trackAiTarget(event: ReactPointerEvent) {
    const badge = cursorBadgeRef.current;
    if (!badge) return;
    const aiTarget = registry?.resolve(event.target instanceof Element ? event.target : null);
    const visible = Boolean(aiTarget?.intents.length);
    badge.style.opacity = visible ? "1" : "0";
    badge.style.transform = `translate3d(${event.clientX + 10}px, ${event.clientY + 12}px, 0) scale(${visible ? 1 : 0.7})`;
  }

  function hideCursorBadge() {
    if (cursorBadgeRef.current) cursorBadgeRef.current.style.opacity = "0";
  }

  function rememberTarget(event: React.MouseEvent) {
    const target = resolveContextTarget(event.target);
    targetRef.current = target;
    setCapabilities({
      canCopy: target.selectedText.length > 0,
      canEdit: target.editable,
      aiTarget: registry?.resolve(event.target instanceof Element ? event.target : null) ?? null,
    });
    hideCursorBadge();
  }

  function copySelection() {
    const text = targetRef.current.selectedText;
    if (text) void navigator.clipboard?.writeText(text);
  }

  function cutSelection() {
    const target = targetRef.current;
    if (!target.editable || !target.selectedText) return;
    void navigator.clipboard?.writeText(target.selectedText);
    replaceSelection(target, "");
  }

  function pasteSelection() {
    const target = targetRef.current;
    if (!target.editable) return;
    void navigator.clipboard?.readText().then((text) => replaceSelection(target, text));
  }

  async function deliverAiIntent(intent: AiContextIntent, delivery: "send" | "copy") {
    try {
      const prompt = await intent.resolvePrompt(delivery);
      if (delivery === "send") {
        if (!agentDock) throw new Error(t("agent.contextMenu.failed"));
        agentDock.sendToAgent({
          prompt,
          source: intent.source,
          label: intent.agentLabel ?? intent.label,
          mode: "send",
        });
        return;
      }
      await navigator.clipboard.writeText(prompt);
      showSuccess(t("agent.contextMenu.copied"));
    } catch (caught) {
      if (intent.reportError?.(delivery) ?? true) {
        showError(
          caught instanceof Error
            ? caught.message
            : t("agent.contextMenu.failed"),
        );
      }
    }
  }

  const aiTarget = capabilities.aiTarget;
  const hasClipboardActions = capabilities.canCopy || capabilities.canEdit;
  const hasAiActions = Boolean(aiTarget?.intents.length);
  const hasTargetActions = Boolean(aiTarget?.actions?.length);

  return <>
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild onContextMenu={rememberTarget} onPointerLeave={hideCursorBadge} onPointerMove={trackAiTarget}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="z-[1100] w-52" data-app-context-menu>
        {capabilities.canCopy && capabilities.canEdit ? (
          <ContextMenuItem onSelect={cutSelection}>
            <Scissors className="mr-2 size-4 text-muted-foreground" />
            {t("common.cut")}
            <ContextMenuShortcut>⌘X</ContextMenuShortcut>
          </ContextMenuItem>
        ) : null}
        {capabilities.canCopy ? (
          <ContextMenuItem onSelect={copySelection}>
            <Copy className="mr-2 size-4 text-muted-foreground" />
            {t("common.copy")}
            <ContextMenuShortcut>⌘C</ContextMenuShortcut>
          </ContextMenuItem>
        ) : null}
        {capabilities.canEdit ? (
          <>
            <ContextMenuItem onSelect={pasteSelection}>
              <ClipboardPaste className="mr-2 size-4 text-muted-foreground" />
              {t("common.paste")}
              <ContextMenuShortcut>⌘V</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => selectAll(targetRef.current)}>
              <Clipboard className="mr-2 size-4 text-muted-foreground" />
              {t("common.selectAll")}
              <ContextMenuShortcut>⌘A</ContextMenuShortcut>
            </ContextMenuItem>
          </>
        ) : null}
        {hasAiActions ? (
          <>
            {hasClipboardActions ? <ContextMenuSeparator /> : null}
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <Bot className="mr-2 size-4 text-muted-foreground" />
                {t("agent.contextMenu.ai")}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="w-64">
                {aiTarget?.intents.length === 1 ? (
                  <IntentDeliveryItems
                    intent={aiTarget.intents[0]}
                    onDeliver={deliverAiIntent}
                    t={t}
                  />
                ) : (
                  aiTarget?.intents.map((intent) => (
                    <ContextMenuSub key={intent.id}>
                      <ContextMenuSubTrigger>{intent.label}</ContextMenuSubTrigger>
                      <ContextMenuSubContent className="w-56">
                        <IntentDeliveryItems
                          intent={intent}
                          onDeliver={deliverAiIntent}
                          t={t}
                        />
                      </ContextMenuSubContent>
                    </ContextMenuSub>
                  ))
                )}
              </ContextMenuSubContent>
            </ContextMenuSub>
          </>
        ) : null}
        {hasTargetActions ? (
          <>
            {hasClipboardActions || hasAiActions ? <ContextMenuSeparator /> : null}
            {aiTarget?.actions?.map((action) => (
              <ContextMenuItem
                className={action.destructive ? "text-destructive focus:text-destructive" : undefined}
                key={action.id}
                onSelect={action.onSelect}
              >
                {action.icon}
                {action.label}
              </ContextMenuItem>
            ))}
          </>
        ) : null}
        {hasClipboardActions || hasAiActions || hasTargetActions ? (
          <ContextMenuSeparator />
        ) : null}
        <ContextMenuItem onSelect={onRefresh}>
          <RefreshCw className="mr-2 size-4 text-muted-foreground" />
          {t("common.refresh")}
          <ContextMenuShortcut>⌘R</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
    {createPortal(
      <div
        aria-hidden="true"
        className="pointer-events-none fixed left-0 top-0 z-[100] grid size-4 place-items-center rounded-full bg-black font-sans text-[8px] font-black leading-none tracking-[-0.04em] text-white opacity-0 shadow-sm transition-[opacity,transform] duration-100 ease-out will-change-transform motion-reduce:transition-none dark:bg-white dark:text-black"
        data-ai-cursor-badge
        ref={cursorBadgeRef}
      >
        AI
      </div>,
      document.body,
    )}
  </>;
}

function IntentDeliveryItems({
  intent,
  onDeliver,
  t,
}: {
  intent: AiContextIntent;
  onDeliver: (intent: AiContextIntent, delivery: "send" | "copy") => Promise<void>;
  t: ReturnType<typeof useT>;
}) {
  return (
    <>
      <ContextMenuItem onSelect={() => void onDeliver(intent, "send")}>
        <SendHorizontal className="mr-2 size-4 text-muted-foreground" />
        {t("agent.contextMenu.send")}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => void onDeliver(intent, "copy")}>
        <Copy className="mr-2 size-4 text-muted-foreground" />
        {t("agent.contextMenu.copy")}
      </ContextMenuItem>
    </>
  );
}
