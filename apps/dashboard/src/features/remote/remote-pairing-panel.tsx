import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Smartphone } from "lucide-react";

import { PairingQr } from "./pairing-qr";
import {
  getRemoteStatus,
  pollRemotePairing,
  startRemotePairing,
  unpairRemote,
  type QrMatrix,
  type RemoteStatus,
} from "@/lib/api/remote";
import { useT } from "@/lib/i18n";

/**
 * Pair this machine with a phone, from the dashboard.
 *
 * Pairing used to be a terminal-only step, which is a poor way to introduce a
 * feature: somebody who lives in this UI had to go and find a shell to put
 * their own machine on their own phone.
 *
 * The code is the only thing shown. The pairing secret behind it is a bearer
 * token until it is exchanged, and it never leaves the daemon — the browser
 * polls, and the daemon completes the exchange itself.
 */
export function RemotePairingPanel() {
  const t = useT();
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [qr, setQr] = useState<QrMatrix | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Stops a poll that outlived the panel from setting state after unmount. */
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await getRemoteStatus();
      if (alive.current) {
        setStatus(next);
      }
    } catch {
      // A status that will not load is not worth an error here: the panel
      // simply offers to pair, which is what an unpaired machine would show.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Polling lives here rather than in the daemon pushing an event, because a
  // pairing is over in a minute or two and a stream for it would outlive its
  // usefulness by a long way.
  useEffect(() => {
    if (!code) {
      return;
    }
    const timer = window.setInterval(async () => {
      try {
        const progress = await pollRemotePairing();
        if (!alive.current) {
          return;
        }
        if (progress.status === "paired") {
          setCode(null);
          setLink(null);
          setQr(null);
          void refresh();
        }
        if (progress.status === "expired") {
          setCode(null);
          setLink(null);
          setQr(null);
          setProblem(t("remote.expired"));
        }
        if (progress.status === "failed") {
          setCode(null);
          setLink(null);
          setQr(null);
          setProblem(progress.error ?? t("remote.failed"));
        }
      } catch {
        // A dropped poll is a network blip; the next tick tries again.
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [code, refresh, t]);

  async function pair() {
    setBusy(true);
    setProblem(null);
    try {
      const started = await startRemotePairing();
      if (!started.ok || !started.userCode) {
        setProblem(started.error ?? t("remote.failed"));
        return;
      }
      setCode(started.userCode);
      setLink(started.verificationUrl ?? null);
      setQr(started.verificationQr ?? null);
    } catch {
      setProblem(t("remote.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function unpair() {
    setBusy(true);
    try {
      await unpairRemote();
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const paired = status?.paired === true;
  const connected = status?.relay?.connected === true;

  return (
    <div className="px-4 py-4 text-xs">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Smartphone className="h-4 w-4" />
        {t("remote.title")}
      </div>
      <p className="mt-1 max-w-prose text-muted-foreground">
        {t("remote.intro")}
      </p>

      {paired ? (
        <div className="mt-4">
          <p className="font-medium">
            {t("remote.pairedAs", { name: status?.deviceName ?? "" })}
          </p>
          <p className="mt-1 text-muted-foreground">
            {connected ? t("remote.connected") : t("remote.notConnected")}
          </p>
          <button
            className="mt-3 rounded border px-3 py-1.5 text-xs disabled:opacity-50"
            disabled={busy}
            onClick={() => void unpair()}
            type="button"
          >
            {t("remote.unpair")}
          </button>
          <p className="mt-2 max-w-prose text-muted-foreground">
            {t("remote.unpairNote")}
          </p>
        </div>
      ) : code ? (
        <div className="mt-4">
          {/*
            The browser showing this dashboard may already be signed in to
            NoMoreIDE, and the claim page claims a `?code=` on its own — so for
            most people this is one click and no typing. The code stays visible
            underneath because the other browser is sometimes a phone.
          */}
          {/*
            The QR first, because it is the only one of the three a phone can
            act on without retyping anything — and getting onto a phone is the
            entire point of the panel. The link and the code stay underneath
            for the browser that is already signed in, and for the phone with
            no camera.
          */}
          {qr ? (
            <div className="mb-4">
              <p className="mb-2 text-muted-foreground">{t("remote.scan")}</p>
              <PairingQr label={t("remote.scanAlt")} matrix={qr} />
            </div>
          ) : null}
          {link ? (
            <>
              <a
                className="inline-block rounded border px-3 py-1.5 text-xs"
                href={link}
                rel="noreferrer"
                target="_blank"
              >
                {t("remote.approve")}
              </a>
              <p className="mt-2 max-w-prose text-muted-foreground">
                {t("remote.approveHint")}
              </p>
            </>
          ) : null}
          <p className="mt-4 text-muted-foreground">{t("remote.orType")}</p>
          <p className="mt-1 font-mono text-2xl tracking-[0.2em]">{code}</p>
          <p className="mt-3 flex items-center gap-1.5 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("remote.pairing")}
          </p>
        </div>
      ) : (
        <button
          className="mt-4 rounded border px-3 py-1.5 text-xs disabled:opacity-50"
          disabled={busy}
          onClick={() => void pair()}
          type="button"
        >
          {t("remote.pair")}
        </button>
      )}

      {problem ? (
        <p className="mt-3 text-destructive" role="alert">
          {problem}
        </p>
      ) : null}

      <p className="mt-4 max-w-prose text-muted-foreground">
        {t("remote.safety")}
      </p>
    </div>
  );
}
