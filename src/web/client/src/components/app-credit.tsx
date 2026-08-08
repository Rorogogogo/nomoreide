import { Heart } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Maker credit. It used to occupy a permanent row at the foot of the sidebar;
 * the sidebar is now a pure navigation rail, so this lives at the bottom of the
 * Settings pane where an "about the author" line actually belongs.
 */
export function AppCredit({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 text-[11px] text-muted-foreground",
        className,
      )}
    >
      <span>Made with</span>
      <Heart
        aria-label="love"
        className="size-3 shrink-0 fill-red-500 text-red-500"
      />
      <span>by Robert Wang</span>
      <a
        aria-label="Robert Wang on LinkedIn"
        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-[#0A66C2]"
        href="https://www.linkedin.com/in/robert-wang-cs/"
        rel="noopener noreferrer"
        target="_blank"
        title="LinkedIn"
      >
        <svg className="size-3.5 fill-current" role="img" viewBox="0 0 24 24">
          <title>LinkedIn</title>
          <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.063 2.063 0 1 1 0-4.126 2.063 2.063 0 0 1 0 4.126zM7.119 20.452H3.554V9h3.565v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.225 0z" />
        </svg>
      </a>
    </div>
  );
}
