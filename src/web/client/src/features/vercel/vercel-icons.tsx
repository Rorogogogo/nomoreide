/**
 * Geist-style icons for the Vercel page.
 *
 * Vercel's own iconography is a distinct dialect — 16px grid, 1.5 stroke, round
 * caps, no fills, and noticeably more geometric than the Lucide set the rest of
 * the app uses. Mixing the two on this page made it read as a NoMoreIDE screen
 * with a Vercel logo pasted on, so the page's own chrome draws from here
 * instead. Elsewhere in the app, keep using Lucide.
 *
 * `currentColor` throughout, so these inherit tab and button treatment.
 */

function Icon({
  children,
  className = "size-4",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
    >
      {children}
    </svg>
  );
}

/** Stacked slabs — deployments as successive builds of the same project. */
export function DeploymentsIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M8 1.5 14.5 5 8 8.5 1.5 5 8 1.5Z" />
      <path d="M1.5 8.5 8 12l6.5-3.5" />
      <path d="M1.5 11.75 8 15.25l6.5-3.5" />
    </Icon>
  );
}

/** Key — environment variables. */
export function EnvIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="5.25" cy="10.75" r="3.25" />
      <path d="m7.6 8.4 6.9-6.9" />
      <path d="M12.25 3.75 14 5.5" />
      <path d="M10.25 5.75 12 7.5" />
    </Icon>
  );
}

/** Globe with the meridians Vercel draws — domains. */
export function DomainsIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M1.5 8h13" />
      <path d="M8 1.5c1.75 1.9 2.75 4.1 2.75 6.5S9.75 12.6 8 14.5C6.25 12.6 5.25 10.4 5.25 8S6.25 3.4 8 1.5Z" />
    </Icon>
  );
}

/** Terminal prompt — logs. */
export function LogsIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect height="12" rx="2" width="13" x="1.5" y="2" />
      <path d="m4.75 6.25 2 1.75-2 1.75" />
      <path d="M8.75 10.25h2.5" />
    </Icon>
  );
}

/** Sliders — the project's build settings. */
export function SettingsIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M2 4.5h3.5M8.5 4.5H14" />
      <path d="M2 11.5h5.5M10.5 11.5H14" />
      <circle cx="7" cy="4.5" r="1.5" />
      <circle cx="9" cy="11.5" r="1.5" />
    </Icon>
  );
}

/** Eye, for revealing a value. */
export function RevealIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8Z" />
      <circle cx="8" cy="8" r="2" />
    </Icon>
  );
}

/** Eye with a slash, for hiding a revealed value again. */
export function HideIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M3 4.5C1.75 5.9 1 8 1 8s2.5 4.5 7 4.5c1.2 0 2.25-.32 3.15-.8" />
      <path d="M13.4 10.35C14.5 9.1 15 8 15 8s-2.5-4.5-7-4.5c-.55 0-1.06.07-1.54.19" />
      <path d="m2 2 12 12" />
    </Icon>
  );
}

/** Copy — duplicating a key or a DNS record onto the clipboard. */
export function CopyIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect height="9" rx="1.5" width="9" x="5.5" y="5.5" />
      <path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-7a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h1" />
    </Icon>
  );
}

/** Check in a circle — a verified domain. */
export function VerifiedIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="8" cy="8" r="6.5" />
      <path d="m5.25 8.25 1.9 1.9 3.6-4.05" />
    </Icon>
  );
}

/** Cross in a circle — a failed deployment. */
export function FailedIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="8" cy="8" r="6.5" />
      <path d="m5.75 5.75 4.5 4.5M10.25 5.75l-4.5 4.5" />
    </Icon>
  );
}

/** Circle with a bar through it — a cancelled deployment. */
export function CanceledIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="8" cy="8" r="6.5" />
      <path d="m3.4 3.4 9.2 9.2" />
    </Icon>
  );
}

/** Dashed circle — queued, blocked, or otherwise not yet doing anything. */
export function PendingIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="8" cy="8" r="6.5" strokeDasharray="2.5 2.5" />
    </Icon>
  );
}

/** Arc, spun by the caller — a build in progress. */
export function SpinnerIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="8" cy="8" opacity="0.25" r="6.5" />
      <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" />
    </Icon>
  );
}

/** Exclamation in a circle — a domain still waiting on DNS. */
export function UnverifiedIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 4.75v3.75" />
      <path d="M8 11.1v.15" />
    </Icon>
  );
}

/** Arrow leaving a box — opening something on vercel.com. */
export function ExternalIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M13.5 9.5v3a1.5 1.5 0 0 1-1.5 1.5H3.5A1.5 1.5 0 0 1 2 12.5V4a1.5 1.5 0 0 1 1.5-1.5h3" />
      <path d="M9.5 2h4.5v4.5" />
      <path d="M14 2 7.5 8.5" />
    </Icon>
  );
}

/** Circular arrow — refresh, and (in the deployment header) redeploy. */
export function RefreshIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M14 8a6 6 0 1 1-1.9-4.4" />
      <path d="M14 1.75v3.5h-3.5" />
    </Icon>
  );
}

/** Arrow up out of a tray — promoting a deployment to production. */
export function PromoteIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M8 10.5V1.75" />
      <path d="m4.75 5 3.25-3.25L11.25 5" />
      <path d="M2 10.5v2A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5v-2" />
    </Icon>
  );
}

/** Arrow curving back — rolling production to an earlier deployment. */
export function RollbackIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M2 8a6 6 0 1 0 1.9-4.4" />
      <path d="M2 1.75v3.5h3.5" />
    </Icon>
  );
}

/** Square with a cross — cancelling a build that is still running. */
export function CancelIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect height="12.5" rx="2" width="12.5" x="1.75" y="1.75" />
      <path d="m6 6 4 4M10 6l-4 4" />
    </Icon>
  );
}

/** Chain link — pinning a repository to a Vercel project. */
export function LinkIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M6.5 9.5a2.75 2.75 0 0 0 4 .2l2-2a2.75 2.75 0 0 0-3.9-3.9l-1.1 1.1" />
      <path d="M9.5 6.5a2.75 2.75 0 0 0-4-.2l-2 2a2.75 2.75 0 0 0 3.9 3.9l1.1-1.1" />
    </Icon>
  );
}

/** Two figures — the team the connection is scoped to. */
export function TeamIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="6" cy="5.5" r="2.5" />
      <path d="M1.75 13.25a4.25 4.25 0 0 1 8.5 0" />
      <path d="M10.5 3.35a2.5 2.5 0 0 1 0 4.3" />
      <path d="M11.75 9.75a4.25 4.25 0 0 1 2.5 3.5" />
    </Icon>
  );
}

/** Terminal chevron — the Vercel CLI sign-in path. */
export function CliIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="m2 3.5 4 4-4 4" />
      <path d="M7.5 12.5H14" />
    </Icon>
  );
}

/** Key in a keyhole — the pasted-token sign-in path. */
export function TokenIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="10.75" cy="5.25" r="3.25" />
      <path d="m8.4 7.6-6.9 6.9" />
      <path d="M3.75 12.25 5.5 14" />
    </Icon>
  );
}

/** Broken chain — disconnecting the Vercel account. */
export function UnlinkIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M6.75 9.25 5.5 10.5a2.75 2.75 0 0 1-3.9-3.9l1.25-1.25" />
      <path d="m9.25 6.75 1.25-1.25a2.75 2.75 0 0 1 3.9 3.9L13.15 10.6" />
      <path d="M1.75 1.75 4 4M12 12l2.25 2.25" />
    </Icon>
  );
}
