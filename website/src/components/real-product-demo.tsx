import { App as WorkbenchApp } from "@/app";
import { installWebsiteMockApi } from "../mock-api";

installWebsiteHistoryGuard();
installWebsiteMockApi();

export function RealProductDemo() {
  return (
    <section id="demo" className="border-y border-border bg-muted/20">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 md:py-24">
        <div className="mb-8 max-w-2xl">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Real UI mock
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight md:text-5xl">
            The actual NoMoreIDE dashboard, backed by fake local data.
          </h2>
          <p className="mt-4 text-sm leading-6 text-muted-foreground md:text-base">
            This is the same React UI used by the product. The website replaces
            every backend response with mock services, placeholder credentials,
            sample logs, and fake git diffs.
          </p>
        </div>

        <div className="website-real-demo relative h-[760px] overflow-hidden rounded-lg border border-border bg-background shadow-2xl">
          <div className="website-real-demo-canvas">
            <WorkbenchApp syncLocation={false} />
          </div>
        </div>
      </div>
    </section>
  );
}

function installWebsiteHistoryGuard() {
  if (typeof window === "undefined") return;
  const currentWindow = window as Window & {
    __nomoreideWebsiteHistoryGuard?: boolean;
  };
  if (currentWindow.__nomoreideWebsiteHistoryGuard) return;
  currentWindow.__nomoreideWebsiteHistoryGuard = true;

  const appRoutes = new Set(["/", "/git", "/agent", "/errors", "/database", "/terminal"]);
  const originalPushState = window.history.pushState.bind(window.history);
  const originalReplaceState = window.history.replaceState.bind(window.history);

  function isEmbeddedAppRoute(url?: string | URL | null) {
    if (url === undefined || url === null) return false;
    const nextUrl = new URL(String(url), window.location.href);
    return nextUrl.origin === window.location.origin && appRoutes.has(nextUrl.pathname);
  }

  window.history.pushState = (data, unused, url) => {
    if (isEmbeddedAppRoute(url)) return;
    return originalPushState(data, unused, url);
  };

  window.history.replaceState = (data, unused, url) => {
    if (isEmbeddedAppRoute(url)) return;
    return originalReplaceState(data, unused, url);
  };
}
