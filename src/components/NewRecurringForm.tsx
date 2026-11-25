"use client";

import { useMemo, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { currencyOptions } from "@/lib/currencies";
import { draftLinesFromInitial, draftLinesToPayload, draftReducer, emptyDraft, type DraftState, type InitialLineLike } from "@/lib/editor/draft";
import { shouldBlockEnterSubmit } from "@/lib/editor/enter-guard";
import { computeDraftTotals } from "@/lib/editor/totals";
import { LineItemsEditor } from "@/components/editor/blocks/LineItemsEditor";
import { EditorCurrencyContext } from "@/components/editor/currency-context";
import { formatCents, parseDecimalInput } from "@/lib/money";
import { PRICE_FIELD_ERROR, toPrice } from "@/lib/editor/parse";
import { SearchSelect } from "@/components/ui/SearchSelect";
import { loadActiveCustomersByIds, loadCustomerById, searchCustomers } from "@/components/ui/customer-lookup";
import { editorCustomerContextSchema } from "@/schemas/lookup";
import { berlinDateKey } from "@/lib/berlin-time";
import { ConfirmDialog, type ConfirmDialogHandle } from "@/components/ui/ConfirmDialog";
import {
  firstStichtag,
  previewPeriods,
  unbilledRest,
  validateLeistungsbeginn,
  type BillingTiming,
  type RecurInterval,
} from "@/lib/recurring";

const TAX_SCHEME_OPTIONS: readonly { value: string; label: string }[] = [
  { value: "REGULAR", label: "Regelbesteuerung" },
  { value: "KLEINUNTERNEHMER", label: "Kleinunternehmer (§ 19)" },
  { value: "DIFFERENZ", label: "Differenzbesteuerung (§ 25a)" },
  { value: "REVERSE_CHARGE", label: "Reverse Charge (§ 13b)" },
  { value: "IG_LIEFERUNG", label: "Innergem. Lieferung (§ 6a)" },
  { value: "IG_LEISTUNG", label: "Innergem. Leistung (§ 3a Abs. 2)" },
  { value: "AUSFUHR", label: "Ausfuhrlieferung (§ 6)" },
  { value: "NICHT_STEUERBAR", label: "Nicht steuerbar, Drittland-Leistung (§ 3a Abs. 2/4/5)" },
];

/** YYYY-MM-DD -> Kalendertag 12:00 lokal (wie die Terminlogik in src/lib/recurring.ts); null bei ungueltiger Eingabe. */
function parseDay(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

function deDay(d: Date): string {
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
}

/** Zahlungsziel aus dem Eingabefeld: 0 ist gueltig; nur leer/unlesbar faellt auf 14 zurueck. */
export function parsePaymentTermsDays(raw: string): number {
  if (raw.trim() === "") return 14;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 14;
}

interface TimingConflict {
  message: string;
  gapDays: number;
  overlapDays: number;
  lastBilled: { start: string; end: string } | null;
  nextPeriod: { start: string; end: string } | null;
}

interface ProductOption {
  id: string;
  name: string;
  unit: string;
  netPriceCents: number;
  taxRate: number;
}
function todayISO(): string {
  return berlinDateKey(new Date());
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
  /** Sammelrechnung (Schalter) und oeffentliche Blockueberschrift; fehlt = aus. */
  collectiveBilling?: boolean;
  invoiceHeading?: string;
  /** Abrechnungsart des Abos; fehlt = nachtraeglich (Bestand). */
  billingTiming?: BillingTiming;
  /** Steuerschema des Abos (beim Bearbeiten nur lesend). */
  taxScheme?: string;
  /** Gespeicherter naechster Stichtag (YYYY-MM-DD) und Ankertag fuer die Vorschau. */
  nextRunDate?: string;
  anchorDay?: number | null;
  issuedCount?: number;
  lines: InitialLineLike[];
}

export function NewRecurringForm({
  products,
  emailTemplates = [],
  defaultAutoFinalize = false,
  defaultAutoSend = false,
  defaultShowPeriodText = true,
  mode = "create",
  recurringId,
  customerName,
  customerEmail: customerEmailProp,
  initial,
  taxRates,
  defaultCurrency = "EUR",
  defaultTaxScheme = "REGULAR",
}: {
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
  /** Nur bei `mode="edit"`: E-Mail des Kunden (`null` = keine) fuer den Hinweis beim automatischen Versand. */
  customerEmail?: string | null;
  /** Vorbelegung bei `mode="edit"` aus dem bestehenden Abo. */
  initial?: RecurringInitialValues;
  /** Org-eigene Steuersatz-Liste (Phase 12c, Fix-Welle I2) — dieselbe Quelle
   *  (`taxRateOptions`, `@/lib/editor/constants`) wie der Beleg-Editor; die Server-Seite
   *  laedt sie ueber `loadDocumentSettings`. Ersetzt die vorher fest verdrahteten 19/7/0. */
  taxRates: readonly number[];
  /** DocumentSettings.defaultCurrency — Vorbelegung, wenn der Kunde keine Vorgabe hat. */
  defaultCurrency?: string;
  /** Organization.defaultTaxScheme — Vorbelegung des Steuerschemas neuer Abos. */
  defaultTaxScheme?: string;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(initial?.title ?? "");
  // Kunde: serverseitige Suche (kein Kundenlisten-Prop); die Waehrungsvorgabe kommt beim Wahlen.
  const [customerId, setCustomerId] = useState("");
  // undefined = noch unbekannt (kein Hinweis); null/leer = Kunde ohne Mailadresse.
  const [customerEmail, setCustomerEmail] = useState<string | null | undefined>(customerEmailProp);
  const customerPick = useRef(0);
  const [interval, setInterval] = useState(initial?.interval ?? "MONTHLY");
  const [intervalCount, setIntervalCount] = useState(String(initial?.intervalCount ?? 1));
  const [startDate, setStartDate] = useState(initial?.startDate ?? todayISO());
  const [endDate, setEndDate] = useState(initial?.endDate ?? "");
  // Phase 8b (§43): harte Obergrenze der Laeufe (RecurringInvoice.maxRuns, Task 1).
  const [maxRuns, setMaxRuns] = useState(initial?.maxRuns ?? "");
  const [billingTiming, setBillingTiming] = useState<BillingTiming>(initial?.billingTiming ?? (mode === "edit" ? "ARREARS" : "ADVANCE"));
  const [taxScheme, setTaxScheme] = useState(initial?.taxScheme ?? defaultTaxScheme);
  const timingDialog = useRef<ConfirmDialogHandle>(null);
  const [timingConflict, setTimingConflict] = useState<TimingConflict | null>(null);
  const pendingPatch = useRef<Record<string, unknown> | null>(null);
  const [paymentTermsDays, setPaymentTermsDays] = useState(String(initial?.paymentTermsDays ?? 14));
  const [autoFinalize, setAutoFinalize] = useState(initial?.autoFinalize ?? defaultAutoFinalize);
  const [autoSend, setAutoSend] = useState(initial?.autoSend ?? defaultAutoSend);
  const [emailTemplateId, setEmailTemplateId] = useState(initial?.emailTemplateId ?? "");
  const [showPeriodText, setShowPeriodText] = useState(initial?.showPeriodText ?? defaultShowPeriodText);
  // Waehrung: Kette Kunde > Einstellung > EUR; manuelle Wahl (currencyTouched) wird durch
  // spaeteren Kundenwechsel nicht ueberschrieben. Beim Bearbeiten gilt der Bestandswert.
  const [currency, setCurrency] = useState(
    initial?.currency ?? defaultCurrency,
  );
  const [currencyTouched, setCurrencyTouched] = useState(mode === "edit");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [collectiveBilling, setCollectiveBilling] = useState(initial?.collectiveBilling ?? false);
  const [invoiceHeading, setInvoiceHeading] = useState(initial?.invoiceHeading ?? "");
  const [draft, dispatch] = useReducer(draftReducer, undefined, () =>
    emptyDraft("INVOICE", {
      taxScheme: (initial?.taxScheme ?? defaultTaxScheme) as "REGULAR",
      currency: initial?.currency ?? defaultCurrency,
      allowedTaxRates: [...taxRates],
      lines: draftLinesFromInitial(initial?.lines, taxRates),
    }),
  );
  const totals = useMemo(() => computeDraftTotals(draft), [draft]);
  const hasUsage = draft.lines.some((l) => l.lineType === "ITEM" && l.billing === "USAGE");
  // Verbrauchspositionen werden immer nachtraeglich abgerechnet.
  const effectiveTiming: BillingTiming = hasUsage ? "ARREARS" : billingTiming;

  const schedule = useMemo(() => {
    const start = parseDay(startDate);
    if (!start) return null;
    const count = Number.isInteger(Number(intervalCount)) && Number(intervalCount) >= 1 ? Number(intervalCount) : 1;
    const iv = interval as RecurInterval;
    const end = endDate ? parseDay(endDate) : null;
    const runs = maxRuns && Number(maxRuns) >= 1 ? Number(maxRuns) : null;
    const stored = initial?.nextRunDate ? parseDay(initial.nextRunDate) : null;
    const unchanged =
      mode === "edit" &&
      initial !== undefined &&
      startDate === initial.startDate &&
      interval === initial.interval &&
      count === initial.intervalCount &&
      effectiveTiming === (initial.billingTiming ?? "ARREARS");
    // Nach dem ersten Lauf (oder unveraendertem Plan) gilt der gespeicherte Stichtag, sonst die Ableitung aus dem Leistungsbeginn.
    const useStored = mode === "edit" && stored !== null && ((initial?.issuedCount ?? 0) > 0 || unchanged);
    const problem = useStored ? null : validateLeistungsbeginn(effectiveTiming, start, iv);
    if (problem) return { problem, periods: [] as ReturnType<typeof previewPeriods>, rest: null as ReturnType<typeof unbilledRest> };
    const first = useStored && stored ? { stichtag: stored, anchorDay: initial?.anchorDay ?? null } : firstStichtag(effectiveTiming, start, iv, count);
    const periods = previewPeriods(
      {
        billingTiming: effectiveTiming,
        nextRunDate: first.stichtag,
        interval: iv,
        intervalCount: count,
        anchorDay: first.anchorDay,
        endDate: end,
        status: "ACTIVE",
        maxRuns: runs,
        issuedCount: mode === "edit" ? (initial?.issuedCount ?? 0) : 0,
      },
      3,
    );
    const rest = unbilledRest({
      billingTiming: effectiveTiming,
      nextRunDate: first.stichtag,
      interval: iv,
      intervalCount: count,
      anchorDay: first.anchorDay,
      endDate: end,
      status: "ACTIVE",
      maxRuns: runs,
      issuedCount: mode === "edit" ? (initial?.issuedCount ?? 0) : 0,
    });
    return { problem: null, periods, rest };
  }, [startDate, interval, intervalCount, endDate, maxRuns, effectiveTiming, mode, initial]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Waehrung des Formulars in den Entwurf spiegeln (Anzeige im Positionsraster).
  function changeCurrency(value: string) {
    setCurrency(value);
    dispatch({ type: "set", field: "currency", value });
  }

  async function selectCustomer(id: string | null) {
    setCustomerId(id ?? "");
    setCustomerEmail(undefined);
    const pick = ++customerPick.current;
    if (!currencyTouched) changeCurrency(defaultCurrency);
    if (!id) return;
    try {
      const res = await fetch(`/api/lookup/customers/${encodeURIComponent(id)}`, { headers: { accept: "application/json" } });
      if (!res.ok) return;
      const ctx = editorCustomerContextSchema.parse(await res.json());
      if (pick !== customerPick.current) return; // Nur die letzte Auswahl zaehlt.
      if (ctx.customer.isArchived) {
        setCustomerId("");
        setError("Archivierte Kunden können keinem neuen Abo zugeordnet werden.");
        return;
      }
      setCustomerEmail(ctx.customer.invoiceEmail?.trim() ? ctx.customer.invoiceEmail : ctx.customer.email);
      // Manuelle Waehrungswahl bleibt erhalten.
      if (!currencyTouched) changeCurrency(ctx.customer.defaultCurrency ?? defaultCurrency);
    } catch {
      // Waehrung bleibt bei der Einstellung; der Server wendet die Kette Kunde > Einstellung > EUR an.
    }
  }

  /** PATCH mit dem gemerkten Patch; `acknowledge` bestaetigt den Wechsel der Abrechnungsart (409 -> Dialog). */
  async function savePatch(acknowledge: boolean) {
    const patch = pendingPatch.current;
    if (!patch) return;
    setBusy(true);
    const res = await fetch(`/api/recurring/${recurringId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patch: acknowledge ? { ...patch, acknowledgeTimingChange: true } : patch }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        reason?: string;
        details?: { gapDays?: number; overlapDays?: number; lastBilled?: { start: string; end: string } | null; nextPeriod?: { start: string; end: string } | null };
      };
      if (res.status === 409 && j.reason === "TIMING_CHANGE_UNACKNOWLEDGED" && !acknowledge) {
        setTimingConflict({
          message: j.error ?? "",
          gapDays: j.details?.gapDays ?? 0,
          overlapDays: j.details?.overlapDays ?? 0,
          lastBilled: j.details?.lastBilled ?? null,
          nextPeriod: j.details?.nextPeriod ?? null,
        });
        timingDialog.current?.open();
        setBusy(false);
        return;
      }
      setError(j.error ?? "Speichern fehlgeschlagen.");
      setBusy(false);
      return;
    }
    router.push(`/abos/${recurringId}`);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const isUsage = (l: (typeof draft.lines)[number]) => l.lineType === "ITEM" && l.billing === "USAGE";
    const invalid = draft.lines.find(
      (l) =>
        !l.description.trim() ||
        (l.lineType === "ITEM" && toPrice(l.price) === null) ||
        (l.lineType === "ITEM" && !isUsage(l) && parseDecimalInput(l.quantity, 3) === null),
    );
    if (invalid) {
      setError(
        !invalid.description.trim()
          ? "Jede Position braucht eine Beschreibung."
          : invalid.lineType === "ITEM" && toPrice(invalid.price) === null
            ? `${PRICE_FIELD_ERROR} – bitte z. B. 1.234,56 oder 0,002 eingeben.`
            : "Menge nicht lesbar – bitte z. B. 2,5 eingeben (höchstens 3 Nachkommastellen).",
      );
      setBusy(false);
      return;
    }

    if (mode === "create" && !customerId) {
      setError("Bitte einen Kunden wählen.");
      setBusy(false);
      return;
    }

    if (collectiveBilling && !invoiceHeading.trim()) {
      setError("Für die Sammelrechnung ist eine Blocküberschrift erforderlich.");
      setBusy(false);
      return;
    }

    const lineInputs = draftLinesToPayload(draft.lines, taxScheme as "REGULAR", { recurring: true });
    if (schedule?.problem) {
      setError(schedule.problem);
      setBusy(false);
      return;
    }

    if (mode === "edit") {
      // Fix-Runde 1: PATCH mit {patch: {...}} (updateRecurringSchema) — bewusst KEIN
      // customerId (kein Kundenwechsel vorgesehen, siehe Task-4-Report).
      const patch = {
        title,
        interval,
        intervalCount: Number(intervalCount) || 1,
        // Nur senden, was sich geaendert hat: ein gesendeter Leistungsbeginn/Wechsel der Abrechnungsart loest
        // vor dem ersten Lauf die Neuberechnung des Stichtags aus; der Ankertag wird nie vom Formular gesendet.
        ...(startDate !== initial?.startDate ? { startDate } : {}),
        ...(effectiveTiming !== (initial?.billingTiming ?? "ARREARS") ? { billingTiming: effectiveTiming } : {}),
        endDate: endDate || null,
        maxRuns: maxRuns ? Number(maxRuns) : null,
        paymentTermsDays: parsePaymentTermsDays(paymentTermsDays),
        autoFinalize,
        autoSend,
        emailTemplateId: emailTemplateId || null,
        showPeriodText,
        notes: notes || null,
        currency,
        collectiveBilling,
        invoiceHeading: collectiveBilling ? invoiceHeading.trim() : null,
        lines: lineInputs,
      };
      pendingPatch.current = patch;
      await savePatch(false);
      return;
    }

    const body = {
      title,
      customerId,
      interval,
      intervalCount: Number(intervalCount) || 1,
      startDate,
      billingTiming: effectiveTiming,
      endDate: endDate || undefined,
      maxRuns: maxRuns ? Number(maxRuns) : undefined,
      paymentTermsDays: parsePaymentTermsDays(paymentTermsDays),
      autoFinalize,
      autoSend,
      emailTemplateId: emailTemplateId || undefined,
      showPeriodText,
      taxScheme,
      // Nur bei manueller Wahl senden; sonst greift die Server-Kette Kunde > Einstellung > EUR
      // (identisch zur hier angezeigten Vorbelegung).
      currency: currencyTouched ? currency : undefined,
      notes: notes || undefined,
      ...(collectiveBilling ? { collectiveBilling: true, invoiceHeading: invoiceHeading.trim() } : {}),
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
          <div className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-ink-soft">Kunde</span>
            <SearchSelect
              label="Kunde"
              placeholder="Kunde suchen…"
              value={customerId === "" ? null : customerId}
              onChange={(id) => void selectCustomer(id)}
              search={searchCustomers}
              loadByIds={loadActiveCustomersByIds}
              loadSelected={loadCustomerById}
              recentKey="customer"
              required
            />
          </div>
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
          <span className="font-medium text-ink-soft">Leistungsbeginn</span>
          <input className={input} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Vertragsende (letzter Leistungstag, optional)</span>
          <input className={input} type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </label>
      </div>

      <fieldset className="space-y-2 rounded-md border border-rule bg-sheet p-4 text-sm">
        <legend className="px-1 font-medium text-ink-soft">Abrechnungsart</legend>
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="radio"
            name="billingTiming"
            value="ADVANCE"
            checked={effectiveTiming === "ADVANCE"}
            disabled={hasUsage}
            onChange={() => setBillingTiming("ADVANCE")}
          />
          <span className="text-ink-soft">Im Voraus (Zeitraum beginnt am Abrechnungstag)</span>
        </label>
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="radio"
            name="billingTiming"
            value="ARREARS"
            checked={effectiveTiming === "ARREARS"}
            disabled={hasUsage}
            onChange={() => setBillingTiming("ARREARS")}
          />
          <span className="text-ink-soft">Nachträglich (Zeitraum endet am Abrechnungstag)</span>
        </label>
        {hasUsage && <p className="text-xs text-ink-muted">Verbrauchspositionen werden nachträglich abgerechnet; die Abrechnungsart ist festgelegt.</p>}
        {schedule?.problem && <p role="alert" className="text-xs text-stamp">{schedule.problem}</p>}
        {schedule && !schedule.problem && schedule.periods.length > 0 && (
          <div data-testid="period-preview" className="space-y-0.5 border-t border-rule pt-2 text-xs text-ink-muted">
            <p className="text-ink-soft">
              Nächste Rechnung am {deDay(schedule.periods[0].runDate)} für {deDay(schedule.periods[0].start)} – {deDay(schedule.periods[0].end)}
            </p>
            {schedule.periods.slice(1).map((p) => (
              <p key={p.runDate.getTime()}>
                Danach am {deDay(p.runDate)} für {deDay(p.start)} – {deDay(p.end)}
              </p>
            ))}
            {schedule.periods.some((p) => p.clippedByEndDate) && (
              <p className="text-seal">Der letzte Zeitraum wird durch das Vertragsende gekürzt.</p>
            )}
            {schedule.rest && (
              <p role="status" data-testid="arrears-rest" className="text-seal">
                Der Zeitraum {deDay(schedule.rest.start)} – {deDay(schedule.rest.end)} liegt nach dem letzten Stichtag und wird nicht abgerechnet.
              </p>
            )}
          </div>
        )}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Steuerschema</span>
          {mode === "edit" ? (
            <span className={`${input} bg-paper text-ink-soft`}>{TAX_SCHEME_OPTIONS.find((o) => o.value === taxScheme)?.label ?? taxScheme}</span>
          ) : (
            <select className={input} value={taxScheme} onChange={(e) => {
                setTaxScheme(e.target.value);
                // Positionseditor und Summen folgen dem Schema (Kleinunternehmer/Reverse Charge: keine Steuersätze).
                dispatch({ type: "set", field: "taxScheme", value: e.target.value as DraftState["taxScheme"] });
              }}>
              {TAX_SCHEME_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Zahlungsziel (Tage)</span>
          <input className={input} type="number" min={0} max={365} value={paymentTermsDays} onChange={(e) => setPaymentTermsDays(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Maximale Läufe (optional)</span>
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
          <span className="text-ink-soft">Leistungszeitraum zusätzlich als Text im Kopftext einfügen (der Zeitraum steht ohnehin im Rechnungskopf)</span>
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
        {autoSend && customerEmail !== undefined && !(customerEmail ?? "").trim() && (
          <p role="status" className="rounded-md border border-seal/40 bg-seal/10 p-2 text-sm text-seal sm:col-span-2">
            Dieser Kunde hat keine E-Mail-Adresse. Die Rechnung wird erzeugt, aber nicht versendet; sie wartet bis zu 7 Tage auf eine Adresse und meldet sich dann in der Glocke.
          </p>
        )}
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

      <div className="space-y-3 rounded-md border border-rule bg-sheet p-4">
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" checked={collectiveBilling} onChange={(e) => setCollectiveBilling(e.target.checked)} />
          <span className="font-medium text-ink-soft">Sammelrechnung</span>
          <span className="text-ink-muted">mit anderen fälligen Abos dieses Kunden in einer Rechnung abrechnen</span>
        </label>
        {collectiveBilling && (
          <>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-ink-soft">
                Blocküberschrift auf der Rechnung <span className="text-stamp">*</span>
              </span>
              <input
                className={input}
                placeholder="z. B. Wartung"
                value={invoiceHeading}
                maxLength={200}
                required
                onChange={(e) => setInvoiceHeading(e.target.value)}
              />
              <span className="text-xs text-ink-muted">Steht öffentlich auf der Rechnung über den Positionen dieses Abos, mit Zwischensumme darunter.</span>
            </label>
            <p className="text-xs text-ink-muted">
              Zusammengefasst werden aktive Abos desselben Kunden mit gleichem Stichtag und gleicher Währung, gleichem Steuerschema, gleicher Sprache,
              gleichem Zahlungsziel sowie gleicher Einstellung für Festschreiben und Versand (bei automatischem Versand auch gleiche Mailvorlage).
              Abos mit Verbrauchspositionen werden erst am Tag nach dem Stichtag abgerechnet; dann gilt das für die ganze Gruppe. Ist kein weiteres
              Abo fällig, entsteht eine normale Rechnung.
            </p>
          </>
        )}
      </div>

      <EditorCurrencyContext.Provider value={draft.currency || defaultCurrency}>
        <LineItemsEditor draft={draft} dispatch={dispatch} products={products} taxRates={taxRates} mode="INVOICE" totals={totals} recurring />
      </EditorCurrencyContext.Provider>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-ink-soft">Hinweis / Notiz (erscheint auf jeder Rechnung)</span>
        <textarea className={input} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>

      <div className="flex items-center justify-between border-t border-rule pt-4">
        <span className="text-sm text-ink-muted">
          Nettosumme je Rechnung: <span className="tabular font-medium text-ink">{formatCents(totals.netCents, currency)}</span>
        </span>
        <button type="submit" disabled={busy} className="rounded-md bg-pen px-5 py-2.5 text-sm font-medium text-on-accent hover:bg-pen-strong disabled:opacity-60">
          {busy ? "Speichert…" : mode === "edit" ? "Änderungen speichern" : "Abo anlegen"}
        </button>
      </div>
      <ConfirmDialog
        ref={timingDialog}
        size="md"
        title="Abrechnungsart wechseln?"
        confirmLabel="Wechsel bestätigen"
        onConfirm={() => void savePatch(true)}
        message={
          <div className="space-y-2">
            <p>Der Wechsel ändert den Zeitraum der nächsten Rechnung.</p>
            {timingConflict?.lastBilled && (
              <p>
                Zuletzt abgerechnet: {deDay(new Date(timingConflict.lastBilled.start))} – {deDay(new Date(timingConflict.lastBilled.end))}
              </p>
            )}
            {timingConflict?.nextPeriod && (
              <p>
                Nächste Rechnung: {deDay(new Date(timingConflict.nextPeriod.start))} – {deDay(new Date(timingConflict.nextPeriod.end))}
              </p>
            )}
            {timingConflict && timingConflict.gapDays > 0 && <p className="text-seal">{timingConflict.gapDays} Tag(e) blieben unberechnet.</p>}
            {timingConflict && timingConflict.overlapDays > 0 && <p className="text-seal">{timingConflict.overlapDays} Tag(e) würden doppelt berechnet.</p>}
          </div>
        }
      />
    </form>
  );
}
