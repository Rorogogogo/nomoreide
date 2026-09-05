import { Smartphone } from "lucide-react";

import { useT } from "@/lib/i18n";
import { RemotePairingPanel } from "./remote-pairing-panel";

/**
 * Remote control, as a page of its own.
 *
 * **It was a settings panel, and that was the wrong shelf.** Settings is where
 * you go to change something you already understand — a toggle, a path, a
 * default. Remote control is a *capability*: it is the answer to "can I see
 * this machine from my phone", which is a thing to discover, not a preference
 * to adjust. Nobody opens Settings looking for a feature they have not heard
 * of, so filing it there meant the only people who found it were the ones who
 * already knew it existed.
 *
 * It sits in the **Run** section beside Services and Activity, because those
 * three answer the same question from different distances: what is this
 * machine doing, and can I reach it.
 */
export function RemoteView() {
  const t = useT();

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-2 flex items-start gap-3">
        <div className="mt-0.5 rounded-md border border-border bg-muted/40 p-2">
          <Smartphone className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">
            {t("remote.title")}
          </h1>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            {t("remote.pageIntro")}
          </p>
        </div>
      </header>

      {/*
        The panel is reused rather than reimplemented. It owns the pairing
        state machine — start, poll, complete, unpair — and a second copy of
        that would be a second thing to keep correct.
      */}
      <div className="rounded-lg border border-border">
        <RemotePairingPanel />
      </div>
    </div>
  );
}
