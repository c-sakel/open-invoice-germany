"use client";

import { useState, useTransition } from "react";
import { checkVatIdAction } from "@/app/actions/vat-check";

export interface VatCheckPanelRow {
  id: string;
  status: "VALID" | "INVALID" | "ERROR";
  errorCode: string | null;
  requestIdentifier: string | null;
  traderName: string | null;
  trigger: "MANUAL" | "FINALIZE";
  /** Vorformatiertes Datum (Server), vermeidet Zeitzonen-Abweichungen bei der Hydration. */
  checkedAtLabel: string;
}

const STATUS_LABEL: Record<VatCheckPanelRow["status"], string> = {
  VALID: "gültig",
  INVALID: "ungültig",
  ERROR: "Fehler",
};

const STATUS_CLASS: Record<VatCheckPanelRow["status"], string> = {
  VALID: "text-ink",
  INVALID: "text-stamp",
  ERROR: "text-ink-muted",
};

export function VatCheckPanel({
  customerId,
  vatId,
  enabled,
  hasElectronicAddress,
  checks,
}: {
  customerId: string;
  vatId: string;
  enabled: boolean;
  hasElectronicAddress: boolean;
  checks: VatCheckPanelRow[];
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const latest = checks[0] ?? null;

  function run() {
    setError(null);
    startTransition(async () => {
      const res = await checkVatIdAction(customerId);
      if (!res.ok) setError(res.error ?? "Prüfung fehlgeschlagen.");
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-soft">
        USt-IdNr. <span className="font-mono text-ink">{vatId}</span>
        {latest && (
          <>
            {" "}
            · letzte Prüfung: <span className={`font-medium ${STATUS_CLASS[latest.status]}`}>{STATUS_LABEL[latest.status]}</span> am {latest.checkedAtLabel}
            {latest.requestIdentifier && (
              <>
                {" "}
                · Konsultationsnummer <span className="font-mono">{latest.requestIdentifier}</span>
              </>
            )}
          </>
        )}
      </p>

      {enabled ? (
        <button
          type="button"
          onClick={run}
          disabled={pending}
          className="rounded-md border border-rule-strong bg-sheet px-4 py-2 text-sm font-medium text-ink-soft hover:bg-paper disabled:opacity-60"
        >
          {pending ? "Prüfe …" : "USt-IdNr. prüfen"}
        </button>
      ) : (
        <p className="text-sm text-ink-soft">Die Prüfung ist abgeschaltet (Einstellungen → Belege).</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-stamp">
          {error}
        </p>
      )}

      {!hasElectronicAddress && (
        <p className="text-sm text-ink-soft">Für XRechnung E-Mail, Leitweg-ID oder Peppol-ID hinterlegen.</p>
      )}

      {checks.length > 0 && (
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Prüfprotokoll der USt-IdNr.</caption>
          <thead>
            <tr className="text-ink-muted">
              <th className="py-1 pr-3 font-medium">Zeitpunkt</th>
              <th className="py-1 pr-3 font-medium">Ergebnis</th>
              <th className="py-1 pr-3 font-medium">Konsultationsnummer</th>
              <th className="py-1 font-medium">Anlass</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((c) => (
              <tr key={c.id} className="border-t border-rule">
                <td className="py-1 pr-3">{c.checkedAtLabel}</td>
                <td className={`py-1 pr-3 ${STATUS_CLASS[c.status]}`}>
                  {STATUS_LABEL[c.status]}
                  {c.errorCode ? ` (${c.errorCode})` : ""}
                </td>
                <td className="py-1 pr-3 font-mono">{c.requestIdentifier ?? "—"}</td>
                <td className="py-1">{c.trigger === "FINALIZE" ? "Festschreiben" : "Manuell"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
