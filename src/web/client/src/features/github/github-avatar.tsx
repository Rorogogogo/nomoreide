import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Public avatar URL for a login. `github.com/<login>.png` needs no token and no
 * API call, which is what lets the account menu show a face for every account
 * `gh` reports — the CLI account list carries only logins. Enterprise hosts have
 * no equivalent unauthenticated route, so they fall back to the generic icon.
 */
export function githubAvatarUrl(host: string, login: string, size = 40): string | undefined {
  if (host !== "github.com") return undefined;
  return `https://github.com/${encodeURIComponent(login)}.png?size=${size}`;
}

/**
 * An account's avatar, falling back to `fallback` (never a broken-image glyph)
 * when the picture can't be fetched — the dashboard runs offline just fine, and
 * GitHub avatars are the one thing on the page that isn't local.
 */
export function GitHubAvatar({
  className,
  fallback = null,
  login,
  src,
}: {
  className?: string;
  fallback?: React.ReactNode;
  login: string;
  src?: string;
}) {
  const [failed, setFailed] = useState(false);
  // A new account means a new URL worth retrying.
  useEffect(() => setFailed(false), [src]);

  if (!src || failed) return <>{fallback}</>;
  return (
    <img
      alt=""
      className={cn("size-4 shrink-0 rounded-full object-cover ring-1 ring-border", className)}
      data-login={login}
      // Not lazy: it is 16px, always on screen, and lazy-loading an image the
      // browser considers off-viewport (a wide header on a narrow window) means
      // it never loads at all.
      onError={() => setFailed(true)}
      referrerPolicy="no-referrer"
      src={src}
    />
  );
}
