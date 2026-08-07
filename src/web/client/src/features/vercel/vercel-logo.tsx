/** Vercel's triangle mark. `currentColor` so it inherits nav/tab treatment. */
export function VercelLogo({ className = "size-4" }: { className?: string }) {
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
