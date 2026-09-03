"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface CustomerOption {
  id: string;
  name: string;
}
interface ProductOption {
  id: string;
  name: string;
  unit: string;
  netPriceCents: number;
  taxRate: number;
}
interface ContactOption {
  id: string;
  customerId: string;
  label: string;
}
interface AddressOption {
  id: string;
  customerId: string;
  label: string;
}
interface LineState {
  description: string;
  quantity: string;
  unit: string;
  price: string;
  taxRate: number;
}

export interface DocumentInitial {
  id: string;
  kind: string;
  customerId: string;
  subject: string;
  customerReference: string;
  contactPersonId: string;
  billingAddressId: string;
  validUntil: string;
  headerText: string;
  footerText: string;
  deliveryTerms: string;
  paymentTerms: string;
  notes: string;
  internalNotes: string;
  lines: LineState[];
}

function emptyLine(): LineState {
  return { description: "", quantity: "1", unit: "C62", price: "0", taxRate: 19 };
}

export function NewDocumentForm({
  customers,
  products,
  contacts = [],
  addresses = [],
  initial,
}: {
  customers: CustomerOption[];
  products: ProductOption[];
  contacts?: ContactOption[];
  addresses?: AddressOption[];
  initial?: DocumentInitial;
}) {
  const router = useRouter();
  const isEdit = Boolean(initial);
  const [kind, setKind] = useState(initial?.kind ?? "ANGEBOT");
  const [customerId, setCustomerId] = useState(initial?.customerId ?? customers[0]?.id ?? "");
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [customerReference, setCustomerReference] = useState(initial?.customerReference ?? "");
  const [contactPersonId, setContactPersonId] = useState(initial?.contactPersonId ?? "");
  const [billingAddressId, setBillingAddressId] = useState(initial?.billingAddressId ?? "");
  const [validUntil, setValidUntil] = useState(initial?.validUntil ?? "");
  const [headerText, setHeaderText] = useState(initial?.headerText ?? "");
  const [footerText, setFooterText] = useState(initial?.footerText ?? "");
  const [deliveryTerms, setDeliveryTerms] = useState(initial?.deliveryTerms ?? "");
  const [paymentTerms, setPaymentTerms] = useState(initial?.paymentTerms ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [internalNotes, setInternalNotes] = useState(initial?.internalNotes ?? "");
  const [lines, setLines] = useState<LineState[]>(initial?.lines?.length ? initial.lines : [emptyLine()]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Kopf-/Fusstext/Bedingungen bei Neuanlage vorbelegen, sobald sich die Art aendert —
  // nur solange der Nutzer noch nichts eingetragen hat und wir nicht bearbeiten.
  useEffect(() => {
    if (isEdit) return;
    async function loadDefault(position: "HEAD" | "FOOT" | "TERMS_DELIVERY" | "TERMS_PAYMENT", set: (v: string) => void, current: string) {
      if (current.trim() !== "") return;
      const res = await fetch(`/api/text-templates/pick?docType=${kind}&position=${position}`);
      if (!res.ok) return;
      const j = (await res.json()) as { body: string | null };
      if (j.body) set(j.body);
    }
    void loadDefault("HEAD", setHeaderText, headerText);
    void loadDefault("FOOT", setFooterText, footerText);
    void loadDefault("TERMS_DELIVERY", setDeliveryTerms, deliveryTerms);
    void loadDefault("TERMS_PAYMENT", setPaymentTerms, paymentTerms);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, isEdit]);

  const toCents = (s: string) => Math.round((parseFloat(s.replace(",", ".")) || 0) * 100);
  const toMilli = (s: string) => Math.round((parseFloat(s.replace(",", ".")) || 0) * 1000);
  const netCents = lines.reduce((sum, l) => sum + Math.round((toMilli(l.quantity) * toCents(l.price)) / 1000), 0);

  const customerContacts = contacts.filter((c) => c.customerId === customerId);
  const customerAddresses = addresses.filter((a) => a.customerId === customerId);

  function patchLine(i: number, patch: Partial<LineState>) {
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function applyProduct(i: number, productId: string) {
    const p = products.find((x) => x.id === productId);
    if (!p) return;
    patchLine(i, { description: p.name, unit: p.unit, price: (p.netPriceCents / 100).toFixed(2), taxRate: p.taxRate });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const linesBody = lines.map((l) => ({
      description: l.description,
      quantityMilli: toMilli(l.quantity),
      unit: l.unit,
      unitNetPriceCents: toCents(l.price),
      taxRate: l.taxRate,
      taxCategory: "S",
      discountPermille: 0,
    }));
    const shared = {
      customerId,
      taxScheme: "REGULAR",
      currency: "EUR",
      subject: subject || undefined,
      customerReference: customerReference || undefined,
      contactPersonId: contactPersonId || undefined,
      billingAddressId: billingAddressId || undefined,
      validUntil: validUntil || undefined,
      headerText: headerText || undefined,
      footerText: footerText || undefined,
      deliveryTerms: deliveryTerms || undefined,
      paymentTerms: paymentTerms || undefined,
      notes: notes || undefined,
      internalNotes: internalNotes || undefined,
      lines: linesBody,
    };

    const res = isEdit
      ? await fetch(`/api/documents/${initial!.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(shared),
        })
      : await fetch("/api/documents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind, ...shared }),
        });

    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? "Speichern fehlgeschlagen.");
      setBusy(false);
      return;
    }
    const j = (await res.json()) as { id: string };
    router.push(`/dokumente/${isEdit ? initial!.id : j.id}`);
    router.refresh();
  }

  const input = "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none";

  return (
    <form onSubmit={submit} className="space-y-6">
      {error && <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>}

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-slate-700">Art</span>
          <select className={input} value={kind} onChange={(e) => setKind(e.target.value)} disabled={isEdit}>
            <option value="ANGEBOT">Angebot</option>
            <option value="AUFTRAGSBESTAETIGUNG">Auftragsbestätigung</option>
            <option value="PROFORMA">Proforma-Rechnung</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-slate-700">Kunde</span>
          <select className={input} value={customerId} onChange={(e) => setCustomerId(e.target.value)} required>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-slate-700">Gültig bis (optional)</span>
          <input type="date" className={input} value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
        </label>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-slate-700">Betreff</span>
          <input className={input} value={subject} onChange={(e) => setSubject(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-slate-700">Kundenreferenz / Bestellnummer</span>
          <input className={input} value={customerReference} onChange={(e) => setCustomerReference(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-slate-700">Ansprechpartner</span>
          <select className={input} value={contactPersonId} onChange={(e) => setContactPersonId(e.target.value)}>
            <option value="">— keiner —</option>
            {customerContacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-slate-700">Rechnungsadresse</span>
          <select className={input} value={billingAddressId} onChange={(e) => setBillingAddressId(e.target.value)}>
            <option value="">— Standardadresse —</option>
            {customerAddresses.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-slate-900">Positionen</h2>
          <button type="button" onClick={() => setLines((ls) => [...ls, emptyLine()])} className="text-sm font-medium text-indigo-600 hover:underline">
            + Position
          </button>
        </div>
        {lines.map((line, i) => (
          <div key={i} className="grid grid-cols-12 gap-2 rounded-lg border border-slate-200 bg-white p-3">
            <div className="col-span-12 flex flex-col gap-1 sm:col-span-5">
              <input className={input} placeholder="Beschreibung" value={line.description} onChange={(e) => patchLine(i, { description: e.target.value })} required />
              {products.length > 0 && (
                <select className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-500" defaultValue="" onChange={(e) => applyProduct(i, e.target.value)}>
                  <option value="">aus Katalog…</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <input className={`${input} col-span-4 sm:col-span-2`} placeholder="Menge" value={line.quantity} onChange={(e) => patchLine(i, { quantity: e.target.value })} />
            <input className={`${input} col-span-3 sm:col-span-1`} placeholder="Einh." value={line.unit} onChange={(e) => patchLine(i, { unit: e.target.value })} />
            <input className={`${input} col-span-5 sm:col-span-2`} placeholder="Preis netto €" value={line.price} onChange={(e) => patchLine(i, { price: e.target.value })} />
            <select className={`${input} col-span-8 sm:col-span-1`} value={line.taxRate} onChange={(e) => patchLine(i, { taxRate: Number(e.target.value) })}>
              <option value={19}>19%</option>
              <option value={7}>7%</option>
              <option value={0}>0%</option>
            </select>
            <button type="button" onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))} className="col-span-4 text-sm text-rose-500 hover:underline sm:col-span-1" disabled={lines.length === 1}>
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-slate-700">Kopftext</span>
          <textarea className={input} rows={3} value={headerText} onChange={(e) => setHeaderText(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-slate-700">Fußtext</span>
          <textarea className={input} rows={3} value={footerText} onChange={(e) => setFooterText(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-slate-700">Lieferbedingungen</span>
          <textarea className={input} rows={2} value={deliveryTerms} onChange={(e) => setDeliveryTerms(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-slate-700">Zahlungsbedingungen</span>
          <textarea className={input} rows={2} value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} />
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-slate-700">Hinweis / Notiz</span>
        <textarea className={input} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-slate-700">
          Interne Notiz
          <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-normal text-amber-800">nur intern sichtbar</span>
        </span>
        <textarea className={input} rows={2} value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)} />
      </label>

      <div className="flex items-center justify-between border-t border-slate-200 pt-4">
        <span className="text-sm text-slate-500">
          Nettosumme: <span className="tabular font-medium text-slate-800">{(netCents / 100).toFixed(2)} €</span>
        </span>
        <button type="submit" disabled={busy} className="rounded-md bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60">
          {busy ? "Speichern…" : isEdit ? "Änderungen speichern" : "Dokument anlegen"}
        </button>
      </div>
    </form>
  );
}
