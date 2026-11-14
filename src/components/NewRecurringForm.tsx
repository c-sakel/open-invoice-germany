"use client";

import { useMemo, useReducer, useState } from "react";
import { useRouter } from "next/navigation";
import { currencyOptions, currencySymbol } from "@/lib/currencies";
import { draftLinesFromInitial, draftLinesToPayload, draftReducer, emptyDraft, type InitialLineLike } from "@/lib/editor/draft";
import { shouldBlockEnterSubmit } from "@/lib/editor/enter-guard";
import { computeDraftTotals } from "@/lib/editor/totals";
import { LineItemsEditor } from "@/components/editor/blocks/LineItemsEditor";
import { EditorCurrencyContext } from "@/components/editor/currency-context";
import { parseDecimalInput } from "@/lib/money";

interface CustomerOption {
  id: string;
  name: string;
  /** Waehrungsvorgabe des Kunden (Customer.defaultCurrency), sonst null. */
  defaultCurrency?: string | null;
}
interface ProductOption {
  id: string;
  name: string;
  unit: string;
  netPriceCents: number;
  taxRate: number;
}
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

interface EmailTemplateOption {
  id: string;
  name: string;
}

export interface RecurringInitialValues {
  title: string;
  interval: string;
  intervalCount: number;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD oder ""
  maxRuns: string; // Zahl als String oder ""
  paymentTermsDays: number;
  autoFinalize: boolean;
  autoSend: boolean;
  emailTemplateId: string;
  showPeriodText: boolean;
  notes: string;
  currency: string;
  lines: InitialLineLike[];
}

export function NewRecurringForm({
  customers,
  products,
  emailTemplates = [],
  defaultAutoFinalize = false,
  defaultAutoSend = false,
  defaultShowPeriodText = true,
  mode = "create",
  recurringId,
  customerName,
  initial,
  taxRates,
  defaultCurrency = "EUR",
}: {
  customers: CustomerOption[];
  products: ProductOption[];
  /** INVOICE-Vorlagen der Organisation (Phase 8b, §43: emailTemplateId — Auswahl fuer den
   *  automatischen Versand, siehe autoSend). */
  emailTemplates?: EmailTemplateOption[];
  /** Vorbelegung aus DocumentSettings.recurringAutoFinalizeDefault (Phase 7, §33). */
  defaultAutoFinalize?: boolean;
  /** Vorbelegung aus DocumentSettings.recurringAutoSendDefault (Phase 7, §33). */
  defaultAutoSend?: boolean;
  /** Vorbelegung aus DocumentSettings.recurringInsertPeriodText (Phase 8b, §43) — wird
   *  beim Anlegen als Ausgangswert des Abo-Felds `showPeriodText` uebernommen. */
  defaultShowPeriodText?: boolean;
  /** Fix-Runde 1 (Koordinator, Abo-Bearbeiten-UI): "edit" schickt ein PATCH
   *  (`{patch: {...}}`, `updateRecurringInvoice`) statt eines POST, blendet die
   *  Kundenauswahl aus (customerId ist nicht Teil von `updateRecurringSchema` — kein
   *  Kundenwechsel vorgesehen, siehe Task-4-Report) und zeigt stattdessen `customerName`
   *  nur lesend an. */
  mode?: "create" | "edit";
  /** Erforderlich bei `mode="edit"` — Ziel-ID fuer `PATCH /api/recurring/[id]`. */
  recurringId?: string;
  /** Nur bei `mode="edit"` angezeigt (read-only, kein Kundenwechsel). */
  customerName?: string;
  /** Vorbelegung bei `mode="edit"` aus dem bestehenden Abo. */
  initial?: RecurringInitialValues;
  /** Org-eigene Steuersatz-Liste (Phase 12c, Fix-Welle I2) — dieselbe Quelle
   *  (`taxRateOptions`, `@/lib/editor/constants`) wie der Beleg-Editor; die Server-Seite
   *  laedt sie ueber `loadDocumentSettings`. Ersetzt die vorher fest verdrahteten 19/7/0. */
  taxRates: readonly number[];
  /** DocumentSettings.defaultCurrency — Vorbelegung, wenn der Kunde keine Vorgabe hat. */
  defaultCurrency?: string;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(initial?.title ?? "");
  // Vorbelegter Kunde: derselbe Datensatz fuer customerId und Initialwaehrung.
  const presetCustomer = customers[0];
  const [customerId, setCustomerId] = useState(presetCustomer?.id ?? "");
  const [interval, setInterval] = useState(initial?.interval ?? "MONTHLY");
  const [intervalCount, setIntervalCount] = useState(String(initial?.intervalCount ?? 1));
  const [startDate, setStartDate] = useState(initial?.startDate ?? todayISO());
  const [endDate, setEndDate] = useState(initial?.endDate ?? "");
  // Phase 8b (§43): harte Obergrenze der Laeufe (RecurringInvoice.maxRuns, Task 1).
  const [maxRuns, setMaxRuns] = useState(initial?.maxRuns ?? "");
  const [paymentTermsDays, setPaymentTermsDays] = useState(String(initial?.paymentTermsDays ?? 14));
  const [autoFinalize, setAutoFinalize] = useState(initial?.autoFinalize ?? defaultAutoFinalize);
  const [autoSend, setAutoSend] = useState(initial?.autoSend ?? defaultAutoSend);
  const [emailTemplateId, setEmailTemplateId] = useState(initial?.emailTemplateId ?? "");
  const [showPeriodText, setShowPeriodText] = useState(initial?.showPeriodText ?? defaultShowPeriodText);
  // Waehrung: Kette Kunde > Einstellung > EUR; manuelle Wahl (currencyTouched) wird durch
  // spaeteren Kundenwechsel nicht ueberschrieben. Beim Bearbeiten gilt der Bestandswert.
  const [currency, setCurrency] = useState(
    initial?.currency ?? presetCustomer?.defaultCurrency ?? defaultCurrency,
  );
  const [currencyTouched, setCurrencyTouched] = useState(mode === "edit");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [draft, dispatch] = useReducer(draftReducer, undefined, () =>
    emptyDraft("INVOICE", {
      taxScheme: "REGULAR",
      currency: initial?.currency ?? presetCustomer?.defaultCurrency ?? defaultCurrency,
      allowedTaxRates: [...taxRates],
      lines: draftLinesFromInitial(initial?.lines, taxRates),
    }),
  );
  const totals = useMemo(() => computeDraftTotals(draft), [draft]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Waehrung des Formulars in den Entwurf spiegeln (Anzeige im Positionsraster).
  function changeCurrency(value: string) {
    setCurrency(value);
    dispatch({ type: "set", field: "currency", value });
  }

  function selectCustomer(id: string) {
    setCustomerId(id);
    if (!currencyTouched) changeCurrency(customers.find((c) => c.id === id)?.defaultCurrency ?? defaultCurrency);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const invalid = draft.lines.find(
      (l) =>
        !l.description.trim() ||
        (l.lineType === "ITEM" && (parseDecimalInput(l.price, 2) === null || parseDecimalInput(l.quantity, 3) === null)),
    );
    if (invalid) {
      setError(
        !invalid.description.trim()
          ? "Jede Position braucht eine Beschreibung."
          : "Betrag oder Menge nicht lesbar – bitte z. B. 1.234,56 oder 1234.56 eingeben (Geld höchstens 2, Mengen höchstens 3 Nachkommastellen).",
      );
      setBusy(false);
      return;
    }

    const lineInputs = draftLinesToPayload(draft.lines, "REGULAR");

    if (mode === "edit") {
      // Fix-Runde 1: PATCH mit {patch: {...}} (updateRecurringSchema) — bewusst KEIN
      // customerId (kein Kundenwechsel vorgesehen, siehe Task-4-Report).
      const patch = {
        title,
        interval,
        intervalCount: Number(intervalCount) || 1,
        startDate,
        endDate: endDate || null,
        maxRuns: maxRuns ? Number(maxRuns) : null,
        paymentTermsDays: Number(paymentTermsDays) || 14,
        autoFinalize,
        autoSend,
        emailTemplateId: emailTemplateId || null,
        showPeriodText,
        notes: notes || null,
        currency,
        lines: lineInputs,
      };
      const res = await fetch(`/api/recurring/${recurringId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patch }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Speichern fehlgeschlagen.");
        setBusy(false);
        return;
      }
      router.push(`/abos/${recurringId}`);
      return;
    }

    const body = {
      title,
      customerId,
      interval,
      intervalCount: Number(intervalCount) || 1,
      startDate,
      endDate: endDate || undefined,
      maxRuns: maxRuns ? Number(maxRuns) : undefined,
      paymentTermsDays: Number(paymentTermsDays) || 14,
      autoFinalize,
      autoSend,
      emailTemplateId: emailTemplateId || undefined,
      showPeriodText,
      taxScheme: "REGULAR",
      // Nur bei manueller Wahl senden; sonst greift die Server-Kette Kunde > Einstellung > EUR
      // (identisch zur hier angezeigten Vorbelegung).
      currency: currencyTouched ? currency : undefined,
      notes: notes || undefined,
      lines: lineInputs,
    };
    const res = await fetch("/api/recurring", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? "Anlegen fehlgeschlagen.");
      setBusy(false);
      return;
    }
    const j = (await res.json()) as { id: string };
    router.push(`/abos/${j.id}`);
  }

  const input = "rounded-md border border-rule-strong px-3 py-2 text-sm focus:border-pen";

  return (
    <form
      onSubmit={submit}
      // Enter in Eingabefeldern (Positionstabelle, Kopf) sendet nicht ab; Speichern nur ueber den Button.
      onKeyDown={(e) => {
        if (shouldBlockEnterSubmit({ key: e.key, isComposing: e.nativeEvent.isComposing, target: e.target as HTMLInputElement })) e.preventDefault();
      }}
      className="space-y-6"
    >
      {error && <div className="rounded-md border border-stamp/30 bg-stamp/10 p-3 text-sm text-stamp">{error}</div>}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Bezeichnung</span>
          <input className={input} placeholder="z. B. Wartungsvertrag Mustermann" value={title} onChange={(e) => setTitle(e.target.value)} required />
        </label>
        {mode === "edit" ? (
          // Fix-Runde 1: kein Kundenwechsel beim Bearbeiten (customerId ist nicht Teil
          // von updateRecurringSchema) — nur lesend anzeigen.
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-ink-soft">Kunde</span>
            <span className={`${input} bg-paper text-ink-soft`}>{customerName}</span>
          </label>
        ) : (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-ink-soft">Kunde</span>
            <select className={input} value={customerId} onChange={(e) => selectCustomer(e.target.value)} required>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Währung</span>
          <select
            className={input}
            value={currency}
            onChange={(e) => {
              changeCurrency(e.target.value);
              setCurrencyTouched(true);
            }}
          >
            {currencyOptions(currency).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          {currency !== "EUR" && (
            <span className="text-xs text-seal">
              Fremdwährung: kein GiroCode. Der Kurs wird beim Festschreiben jeder erzeugten Rechnung eingefroren; die USt wird zusätzlich in EUR ausgewiesen (Art. 230 MwStSystRL, § 16 Abs. 6 UStG).
            </span>
          )}
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Rhythmus</span>
          <select className={input} value={interval} onChange={(e) => setInterval(e.target.value)}>
            {/* Phase 8b (§43): DAY ergaenzt WEEKLY/MONTHLY/QUARTERLY/YEARLY. */}
            <option value="DAY">täglich</option>
            <option value="WEEKLY">wöchentlich</option>
            <option value="MONTHLY">monatlich</option>
            <option value="QUARTERLY">vierteljährlich</option>
            <option value="YEARLY">jährlich</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">alle N Intervalle</span>
          <input className={input} type="number" min={1} max={48} value={intervalCount} onChange={(e) => setIntervalCount(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Startdatum</span>
          <input className={input} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Enddatum (optional)</span>
          <input className={input} type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </label>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Zahlungsziel (Tage)</span>
          <input className={input} type="number" min={0} max={365} value={paymentTermsDays} onChange={(e) => setPaymentTermsDays(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Maximale Laeufe (optional)</span>
          <input
            className={input}
            type="number"
            min={1}
            value={maxRuns}
            onChange={(e) => setMaxRuns(e.target.value)}
            placeholder="unbegrenzt"
          />
        </label>
        <label className="flex cursor-pointer items-center gap-2 self-end rounded-md border border-rule bg-sheet px-3 py-2 text-sm">
          <input type="checkbox" checked={showPeriodText} onChange={(e) => setShowPeriodText(e.target.checked)} />
          <span className="text-ink-soft">Leistungszeitraum-Text auf der Rechnung einfügen</span>
        </label>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex cursor-pointer items-center gap-2 self-end rounded-md border border-rule bg-sheet px-3 py-2 text-sm">
          <input
            type="checkbox"
            checked={autoFinalize}
            disabled={autoSend}
            onChange={(e) => setAutoFinalize(e.target.checked)}
          />
          <span className="text-ink-soft">Rechnungen automatisch festschreiben (sofort GoBD-konform &amp; nummeriert)</span>
        </label>
        <label className="flex cursor-pointer items-center gap-2 self-end rounded-md border border-rule bg-sheet px-3 py-2 text-sm">
          <input
            type="checkbox"
            checked={autoSend}
            onChange={(e) => {
              const checked = e.target.checked;
              setAutoSend(checked);
              // S4 (Fix-Welle): Versand setzt Festschreibung voraus — sonst ginge eine
              // Rechnung mit Nummer/GiroCode "ENTWURF" per E-Mail raus.
              if (checked) setAutoFinalize(true);
            }}
          />
          <span className="text-ink-soft">
            Rechnungen automatisch per E-Mail versenden
            {autoSend && <span className="block text-xs text-ink-muted">Versand setzt Festschreibung voraus.</span>}
          </span>
        </label>
        {autoSend && emailTemplates.length > 0 && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-ink-soft">E-Mail-Vorlage (optional)</span>
            <select className={input} value={emailTemplateId} onChange={(e) => setEmailTemplateId(e.target.value)}>
              <option value="">— Standardvorlage —</option>
              {emailTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <EditorCurrencyContext.Provider value={draft.currency || defaultCurrency}>
        <LineItemsEditor draft={draft} dispatch={dispatch} products={products} taxRates={taxRates} mode="INVOICE" totals={totals} />
      </EditorCurrencyContext.Provider>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-ink-soft">Hinweis / Notiz (erscheint auf jeder Rechnung)</span>
        <textarea className={input} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>

      <div className="flex items-center justify-between border-t border-rule pt-4">
        <span className="text-sm text-ink-muted">
          Nettosumme je Rechnung: <span className="tabular font-medium text-ink">{(totals.netCents / 100).toFixed(2)} {currencySymbol(currency)}</span>
        </span>
        <button type="submit" disabled={busy} className="rounded-md bg-pen px-5 py-2.5 text-sm font-medium text-on-accent hover:bg-pen-strong disabled:opacity-60">
          {busy ? "Speichert…" : mode === "edit" ? "Änderungen speichern" : "Abo anlegen"}
        </button>
      </div>
    </form>
  );
}
