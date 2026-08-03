import { useEffect, useRef, useState } from "react";
import {
  removeGitHubToken,
  selectGitHubCredential,
  type GitHubCredentialSelection,
  type GitHubTokenInfo,
} from "@/lib/api";
import { useOperations } from "@/components/operations/operation-context";
import { useT } from "@/lib/i18n";

/** Wide enough for "Add a personal access token…" without an ellipsis. */
export const ACCOUNT_MENU_WIDTH = 252;

/**
 * The account menu's state and API calls, shared by the two places that open
 * it: the app header (its home — the credential is per repository, and the
 * repository crumb is right there) and the connection-recovery screen, which
 * has to offer it before the header is trustworthy.
 *
 * Split from the trigger so `saving` survives the menu closing — selecting an
 * account closes the menu and the trigger keeps showing the spinner.
 */
export function useGitHubAccountMenu({
  align = "start",
  info,
  onChanged,
}: {
  /** "end" right-aligns the menu under the trigger, for header-corner use. */
  align?: "start" | "end";
  info: GitHubTokenInfo;
  onChanged: () => void;
}) {
  const t = useT();
  const { runOperation } = useOperations();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [coords, setCoords] = useState({ top: 0, left: 0 });

  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const left = align === "end" ? rect.right - ACCOUNT_MENU_WIDTH : rect.left;
      setCoords({
        top: rect.bottom + 4,
        left: Math.max(8, Math.min(left, window.innerWidth - ACCOUNT_MENU_WIDTH - 8)),
      });
    }
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    function onScroll(event: Event) {
      if (menuRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  async function select(credential: GitHubCredentialSelection) {
    if (!info.repositoryName) return;
    setOpen(false);
    setSaving(true);
    setError(null);
    try {
      await selectGitHubCredential(info.repositoryName, credential);
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  /**
   * The only sign-out NoMoreIDE can perform: removing a token we stored. A `gh`
   * credential belongs to the CLI and is left alone, so the menu offers this
   * beside the stored-token row and nothing at all for `gh` accounts.
   */
  async function disconnect() {
    setOpen(false);
    setSaving(true);
    setError(null);
    try {
      await runOperation(
        {
          errorMessage: (caught) =>
            caught instanceof Error ? caught.message : String(caught),
          key: "github:disconnect",
          label: t("github.disconnecting"),
        },
        async () => {
          await removeGitHubToken("github.com");
          onChanged();
        },
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return {
    close: () => setOpen(false),
    coords,
    disconnect,
    error,
    menuRef,
    open,
    saving,
    select,
    toggle,
    triggerRef,
  };
}

export type GitHubAccountMenuController = ReturnType<typeof useGitHubAccountMenu>;
