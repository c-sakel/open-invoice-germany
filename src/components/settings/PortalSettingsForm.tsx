"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { savePortalSettingsAction } from "@/app/einstellungen/kundenportal/actions";
import type { PortalSettingsView } from "@/domain/portal/settings";
import { inputCls, ErrorBanner } from "@/components/forms/fields";
import { Button } from "@/components/ui/Button";

const MAIL_PLACEHOLDERS: { path: string; label: string }[] = [
  { path: "portal.url", label: "Link zum Kundenportal" },
  { path: "portal.validUntil", label: "Link gültig bis" },
  { path: "customer.name", label: "Kundenname" },
  { path: "company.name", label: "Firmenname" },
  { path: "company.email", label: "Firmen-E-Mail" },
  { path: "company.phone", label: "Firmentelefon" },
];

export function PortalSettingsForm({ initial }: { initial: PortalSettingsView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [linkDays, setLinkDays] = useState(String(initial.linkDays));
  const [showDunnings, setShowDunnings] = useState(initial.showDunnings);
  const [showEInvoice, setShowEInvoice] = useState(initial.showEInvoice);
  const [mailSubject, setMailSubject] = useState(initial.mailSubject ?? "");
  const [mailBody, setMailBody] = useState(initial.mailBody ?? "");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    const days = Number(linkDays);
    if (!Number.isInteger(days) || days < 1 || days > 730) {
      setError("Gültigkeit des Links: bitte eine ganze Zahl von 1 bis 730 Tagen eingeben.");
      return;
    }
    const payload = {
      enabled,
      linkDays: days,
      showDunnings,
      showEInvoice,
      mailSubject: mailSubject.trim() === "" ? null : mailSubject,
      mailBody: mailBody.trim() === "" ? null : mailBody,
    };
    start(async () => {
      const res = await savePortalSettingsAction(payload);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDone(true);
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <div
        role="status"
        className={`rounded-md border p-3 text-sm font-medium ${enabled ? "border-ledger/30 bg-ledger/10 text-ledger" : "border-rule bg-paper text-ink-soft"}`}
      >
        {enabled ? "Das Kundenportal ist eingeschaltet." : "Das Kundenportal ist ausgeschaltet. Bestehende Links zeigen nichts an."}
      </div>
      <ErrorBanner message={error ?? undefined} />
      {done && <p className="text-sm text-ledger">Einstellungen gespeichert.</p>}

      <section className="space-y-4 rounded-[var(--radius-card)] border border-rule bg-sheet p-5">
        <h2 className="font-semibold text-ink">Allgemein</h2>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span className="font-medium text-ink-soft">Kundenportal einschalten</span>
        </label>
        <label className="flex max-w-xs flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Gültigkeit neuer Links (Tage)</span>
          <input className={inputCls} inputMode="numeric" value={linkDays} onChange={(e) => setLinkDays(e.target.value)} />
          <span className="text-xs text-ink-muted">1 bis 730 Tage, Standard 365.</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showDunnings} onChange={(e) => setShowDunnings(e.target.checked)} />
          <span className="text-ink-soft">Versendete Mahnungen im Portal anzeigen</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showEInvoice} onChange={(e) => setShowEInvoice(e.target.checked)} />
          <span className="text-ink-soft">E-Rechnung (XML) zum Download anbieten</span>
        </label>
      </section>

      <section className="space-y-4 rounded-[var(--radius-card)] border border-rule bg-sheet p-5">
        <h2 className="font-semibold text-ink">Mail mit dem Portal-Link</h2>
        <p className="text-xs text-ink-muted">Leer lassen, um den eingebauten Text in der Sprache des Kunden zu verwenden.</p>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Betreff</span>
          <input className={inputCls} value={mailSubject} maxLength={200} onChange={(e) => setMailSubject(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Text</span>
          <textarea className={`${inputCls} min-h-40`} value={mailBody} maxLength={5000} onChange={(e) => setMailBody(e.target.value)} />
        </label>
        <div className="text-xs text-ink-muted">
          <p className="mb-1 font-medium text-ink-soft">Verfügbare Platzhalter</p>
          <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            {MAIL_PLACEHOLDERS.map((p) => (
              <li key={p.path}>
                <code className="rounded bg-paper px-1">{`{{${p.path}}}`}</code> {p.label}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Speichern …" : "Speichern"}
      </Button>
    </form>
  );
}
