"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { parseDecimalInput } from "@/lib/money";

export interface CustomerDefaultsData {
  defaultCurrency: string | null;
  defaultDiscountPermille: number;
  invoiceEmail: string | null;
  invoiceCc: string | null;
  quoteEmail: string | null;
  eInvoicePreferred: boolean;
  orderReference: string | null;
  deliveryTermsText: string | null;
  paymentTermsText: string | null;
  language: string;
}

/** Kundenvorgaben (§28) — Vollersatz-Formular (kein Merge, siehe Domain-Kommentar). */
export function CustomerDefaultsForm({ customerId, initial }: { customerId: string; initial: CustomerDefaultsData }) {
  const router = useRouter();
  const [defaultCurrency, setDefaultCurrency] = useState(initial.defaultCurrency ?? "");
  const [defaultDiscountPercent, setDefaultDiscountPercent] = useState((initial.defaultDiscountPermille / 10).toString());
  const [invoiceEmail, setInvoiceEmail] = useState(initial.invoiceEmail ?? "");
  const [invoiceCc, setInvoiceCc] = useState(initial.invoiceCc ?? "");
  const [quoteEmail, setQuoteEmail] = useState(initial.quoteEmail ?? "");
  const [eInvoicePreferred, setEInvoicePreferred] = useState(initial.eInvoicePreferred);
  const [orderReference, setOrderReference] = useState(initial.orderReference ?? "");
  const [deliveryTermsText, setDeliveryTermsText] = useState(initial.deliveryTermsText ?? "");
  const [paymentTermsText, setPaymentTermsText] = useState(initial.paymentTermsText ?? "");
  const [language, setLanguage] = useState(initial.language);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    if (defaultDiscountPercent.trim() !== "" && parseDecimalInput(defaultDiscountPercent, 1) === null) {
      setError("Rabatt nicht lesbar – bitte z. B. 2,5 eingeben (höchstens 1 Nachkommastelle).");
      setBusy(false);
      return;
    }
    const body = {
      defaultCurrency: defaultCurrency || undefined,
      defaultDiscountPermille: Math.max(0, Math.min(1000, (parseDecimalInput(defaultDiscountPercent, 1) ?? 0))),
      invoiceEmail: invoiceEmail || undefined,
      invoiceCc: invoiceCc || undefined,
      quoteEmail: quoteEmail || undefined,
      eInvoicePreferred,
      orderReference: orderReference || undefined,
      deliveryTermsText: deliveryTermsText || undefined,
      paymentTermsText: paymentTermsText || undefined,
      language,
    };
    const res = await fetch(`/api/customers/${customerId}/defaults`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? "Speichern fehlgeschlagen.");
      setBusy(false);
      return;
    }
    setBusy(false);
    setSaved(true);
    router.refresh();
  }

  const input = "rounded-md border border-rule-strong px-3 py-2 text-sm focus:border-pen";

  return (
    <form onSubmit={submit} className="space-y-4 rounded-[var(--radius-card)] border border-rule bg-sheet p-4">
      {error && <div className="rounded-md border border-stamp/30 bg-stamp/10 p-2 text-xs text-stamp">{error}</div>}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Standard-Währung (ISO 4217)</span>
          <input className={input} value={defaultCurrency} onChange={(e) => setDefaultCurrency(e.target.value.toUpperCase())} placeholder="Systemvorgabe" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Standard-Rabatt (%)</span>
          <input className={input} value={defaultDiscountPercent} onChange={(e) => setDefaultDiscountPercent(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Rechnungs-E-Mail</span>
          <input className={input} value={invoiceEmail} onChange={(e) => setInvoiceEmail(e.target.value)} placeholder="Standard des Kunden" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Rechnungs-CC (bis 5, kommagetrennt)</span>
          <input className={input} value={invoiceCc} onChange={(e) => setInvoiceCc(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Angebots-E-Mail</span>
          <input className={input} value={quoteEmail} onChange={(e) => setQuoteEmail(e.target.value)} placeholder="Standard des Kunden" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Bestellreferenz</span>
          <input className={input} value={orderReference} onChange={(e) => setOrderReference(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Belegsprache</span>
          <select className={input} value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="de">Deutsch</option>
            <option value="en">English</option>
            {language !== "de" && language !== "en" && <option value={language}>{language} (Belege auf Deutsch)</option>}
          </select>
          <span className="text-xs text-ink-muted">Neue Belege, E-Mails und Vorlagen für diesen Kunden folgen dieser Sprache (am Beleg änderbar).</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={eInvoicePreferred} onChange={(e) => setEInvoicePreferred(e.target.checked)} className="h-4 w-4 rounded-[var(--radius-control)] border-rule-strong" />
          <span className="font-medium text-ink-soft">E-Rechnung bevorzugt (kann die Org-Vorbelegung nur einschalten)</span>
        </label>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-ink-soft">Lieferbedingungen (Angebote)</span>
        <textarea className={input} rows={2} value={deliveryTermsText} onChange={(e) => setDeliveryTermsText(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-ink-soft">Zahlungsbedingungen</span>
        <textarea className={input} rows={2} value={paymentTermsText} onChange={(e) => setPaymentTermsText(e.target.value)} />
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy} className="rounded-md bg-pen px-4 py-2 text-sm font-medium text-on-accent hover:bg-pen-strong disabled:opacity-60">
          {busy ? "Speichern…" : "Vorgaben speichern"}
        </button>
        {saved && <span className="text-xs text-ledger">Gespeichert.</span>}
      </div>
    </form>
  );
}
