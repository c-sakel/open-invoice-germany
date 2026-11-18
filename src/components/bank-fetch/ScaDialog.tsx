"use client";

import { useEffect, useRef, useState } from "react";
import type { PublicChallenge } from "@/domain/bank-fetch/setup";
import { Button } from "@/components/ui/Button";
import { inputCls } from "@/components/forms/fields";
import { isSafeImageDataUrl, OPTICAL_CHIPTAN_HINT } from "./bank-fetch-ui";

const TAN_RE = /^[0-9A-Za-z]{1,20}$/;
const MIN_POLL_MS = 2000;

interface Props {
  challenge: PublicChallenge;
  busy: boolean;
  onContinue: (tan?: string) => void;
  onCancel: () => void;
}

/**
 * Freigabe einer Bankanfrage. Freigabe in der Banking-App: die Oberfläche fragt im Abstand der Bank nach (der Server
 * erzwingt die Wartezeit). Sonst Eingabe einer TAN. Der Text der Bank erscheint nur als Text, ein Bild nur als
 * Rastergrafik (Daten-URL). Die TAN bleibt im Eingabefeld und wird nie gespeichert.
 */
export function ScaDialog({ challenge, busy, onContinue, onCancel }: Props) {
  const [tan, setTan] = useState("");
  const cb = useRef(onContinue);
  useEffect(() => {
    cb.current = onContinue;
  });

  useEffect(() => {
    if (!challenge.decoupled || busy) return;
    const t = setTimeout(() => cb.current(), Math.max(challenge.waitMs, MIN_POLL_MS));
    return () => clearTimeout(t);
  }, [challenge, busy]);

  const image = isSafeImageDataUrl(challenge.imageDataUrl) ? challenge.imageDataUrl : null;
  const tanOk = TAN_RE.test(tan);

  return (
    <section role="dialog" aria-label="Freigabe" className="space-y-3 rounded-md border border-pen/40 bg-paper p-4 text-sm">
      {challenge.decoupled ? (
        <p className="font-medium text-ink">Bitte in Ihrer Banking-App freigeben.</p>
      ) : (
        <p className="font-medium text-ink">Bitte die TAN eingeben.</p>
      )}
      {challenge.text !== "" ? <p className="whitespace-pre-line break-words text-ink-soft">{challenge.text}</p> : null}
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element -- Daten-URL einer Rastergrafik der Bank (png, jpeg, gif)
        <img src={image} alt="Grafik zur TAN-Eingabe" className="max-h-64 max-w-full rounded border border-rule bg-white p-2" />
      ) : null}
      {challenge.imageOmitted ? <p className="text-seal">{OPTICAL_CHIPTAN_HINT}</p> : null}
      {challenge.decoupled ? (
        <p role="status" className="text-ink-muted">
          {busy ? "Wird geprüft …" : "Warte auf die Freigabe. Diese Seite fragt automatisch nach."}
        </p>
      ) : (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!tanOk) return;
            const value = tan;
            setTan("");
            onContinue(value);
          }}
        >
          <label className="flex min-w-0 flex-col gap-1">
            <span className="font-medium text-ink-soft">TAN</span>
            <input className={`${inputCls} w-48`} type="password" autoComplete="off" inputMode="text" maxLength={20} value={tan} onChange={(e) => setTan(e.target.value)} />
          </label>
          <Button type="submit" variant="primary" disabled={busy || !tanOk}>
            TAN senden
          </Button>
        </form>
      )}
      <Button variant="secondary" disabled={!challenge.decoupled && busy} onClick={onCancel}>
        Abbrechen
      </Button>
    </section>
  );
}
