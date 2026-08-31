import { Cloud, Rocket } from "lucide-react";

/**
 * The mark for a deploy provider.
 *
 * Vercel keeps its own triangle because it is unmistakable at 14px and was
 * already here. Everything else draws from lucide rather than an inlined brand
 * path: a mangled half-remembered logo looks worse than an honest generic
 * glyph, and a provider's real mark belongs in its manifest (`icon`, §6 of the
 * design plan) once the manifest carries assets at all.
 */

/** Vercel's triangle mark. `currentColor` so it inherits nav/tab treatment. */
export function VercelMark({ className = "size-4" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="currentColor"
      viewBox="0 0 76 65"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M37.59.25l36.95 64H.64l36.95-64z" />
    </svg>
  );
}

export function ProviderLogo({
  className = "size-4",
  providerId,
}: {
  className?: string;
  /** Omitted in provider-agnostic chrome (the nav entry), which gets the generic mark. */
  providerId?: string;
}) {
  if (providerId === "vercel") return <VercelMark className={className} />;
  if (providerId === "cloudflare") return <Cloud aria-hidden className={className} />;
  return <Rocket aria-hidden className={className} />;
}
