"use client";

/**
 * Belegdaten-Block (Phase 11c, Task 4, rechte Spalte ab `md`): Modus-spezifische
 * Kopf-Metadaten (Typ/Art, Steuerschema, Termine, Zahlungsmethode, Kundenreferenz) +
 * Betreff.
 *
 * Betreff erscheint NUR bei INVOICE/DOCUMENT: `DeliveryNote` hat weder in Prisma-Schema
 * noch in `toDeliveryNotePayload` (Task 1) ein `subject`-Feld — ein hier angezeigtes
 * Feld wuerde beim Speichern stillschweigend verworfen (Code schlaegt Doku, Lastenheft
 * 61.6), obwohl der Brief „alle: Betreff" nennt. Siehe Task-4-Report, offener Punkt.
 *
 * Phase 13b, Task 2: „Rechnungsdatum" (nur INVOICE, `draft.issueDate`), eine Kopplung
 * „Leistungsdatum entspricht dem Rechnungsdatum" (`draft.deliveryDateFollowsIssue` — die
 * eigentliche Nachzieh-Logik sitzt im Reducer, `draftReducer`s `case "set"`, siehe dort)
 * und „Fällig am" als Datum+Tageszahl-Paar (`dueDaysFrom`/`dueDateFromDays`, reine
 * Helfer aus `draft.ts`) statt der bisherigen drei Schnellknöpfe — deren Funktion steckt
 * jetzt vollständig im Tagesfeld.
 */
import { useEffect, useRef } from "react";
import { dueDaysFrom, dueDateFromDays, resolveDueDays, localDateOnly, type DraftState, type DraftAction } from "@/lib/editor/draft";
import type { EditorMode } from "@/lib/editor/constants";
import { EditorField } from "../EditorField";
import { inputCls } from "@/components/forms/fields";
import type { RecipientCustomerOption } from "./RecipientBlock";
import { currencyOptions } from "@/lib/currencies";
import { useEditorCurrency } from "../currency-context";
import { CARD_NETWORK_SUGGESTIONS } from "@/lib/payment-card";
import { FxPreview } from "@/components/fx/FxPreview";

export interface PaymentMethodOption {
  id: string;
  name: string;
  paymentTermsDays?: number | null;
  /** UNTDID 4461 (BT-81) der Methode; steuert Karten-/Lastschrift-Felder (Phase 18e). */
  untdidCode?: string | null;
}

const CARD_CODES: ReadonlySet<string> = new Set(["48", "54", "55"]);

export function MetaBlock({
  mode,
  isEdit,
  draft,
  dispatch,
  customers = [],
  paymentMethods = [],
  invoiceDueDays,
  taxCents = 0,
}: {
  mode: EditorMode;
  isEdit: boolean;
  draft: DraftState;
  dispatch: (action: DraftAction) => void;
  /** Fix-Welle 1, M2: dieselbe Kundenliste wie `RecipientBlock` — nur fuer
   *  `defaultPaymentTermsDays` gebraucht (Faelligkeits-Vorbelegung bei Neuanlage). */
  customers?: RecipientCustomerOption[];
  paymentMethods?: PaymentMethodOption[];
  /** Fix-Welle 1, M2: `DocumentSettings.invoiceDueDays` — dritte Stufe der Vorbelegungs-
   *  Kette (`resolveDueDays`), fehlt nur, wenn der Aufrufer sie nicht laedt (dann greift
   *  dort ohnehin der Systemdefault 14). */
  invoiceDueDays?: number;
  /** Phase 16b: USt des Belegs in Belegwaehrung (Live-Summen) — Grundlage der "USt in EUR"-Vorschau. */
  taxCents?: number;
}) {
  const displayCurrency = useEditorCurrency();
  const selectedMethod = paymentMethods.find((m) => m.id === draft.paymentMethodId);
  const selectedCustomer = customers.find((c) => c.id === draft.customerId);
  // `issueDate || heute` als Bezug: `createDraftInvoice` setzt bei leerem Feld genau das
  // (invoice/create.ts:102) — der Editor darf keine andere Frist zeigen als der
  // gespeicherte Beleg (Ruling). N6 (Fix-Welle 1): `localDateOnly` statt UTC-Tag —
  // dieselbe Begruendung wie bei S1 (`src/lib/editor/draft.ts`), hier nur fuer die
  // "heute"-Vorbelegung der Faelligkeitsfrist (kein Speicherpfad betroffen).
  const issueRef = draft.issueDate || localDateOnly(new Date());

  // Vorbelegung der Tageszahl beim ersten Oeffnen einer Neuanlage (Ruling, Fix-Welle 1
  // M2): `draftRef` haelt denselben aktuellen Entwurf wie `DocumentEditor.tsx:145-148`
  // (identisches Muster) — ohne ihn wuerde ein `dispatch({ type: "replace", ... })` mit der
  // in der Effekt-Closure eingefrorenen `draft`-Variable zwischenzeitliche Eingaben in
  // anderen Feldern verwerfen. Der Guard "`dueDate` noch leer" sorgt zugleich dafuer, dass
  // die Vorbelegung nur EINMAL greift — sobald ein Wert gesetzt ist (ob durch diesen Effekt
  // oder den Nutzer selbst), ueberschreibt der Effekt ihn nicht mehr. `resolveDueDays`
  // bildet DIESELBE Prioritaetskette wie der Server (Kunde > Zahlungsmethode >
  // Org-Einstellung > 14 Tage) — anders als vorher (nur Zahlungsmethode) laeuft die
  // Vorbelegung jetzt IMMER, auch ohne gewaehlte Methode. Der Dispatch nutzt bewusst
  // "replace" statt "set": eine reine Anzeige-Vorbelegung darf `dueDateTouched` nicht
  // setzen, sonst wuerde `toInvoicePayload` sie wie eine Nutzereingabe senden (siehe dort).
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  useEffect(() => {
    if (mode !== "INVOICE" || isEdit) return;
    if (draftRef.current.dueDate.trim() !== "") return;
    const days = resolveDueDays(selectedCustomer?.defaultPaymentTermsDays, selectedMethod?.paymentTermsDays, invoiceDueDays);
    const ref = draftRef.current.issueDate || localDateOnly(new Date());
    const next = dueDateFromDays(ref, String(days));
    if (!next) return;
    dispatch({ type: "replace", state: { ...draftRef.current, dueDate: next } });
  }, [mode, isEdit, selectedCustomer, selectedMethod, invoiceDueDays, dispatch]);

  return (
    <div className="space-y-4 rounded-[var(--radius-card)] border border-rule bg-sheet p-4">
      <h2 className="font-semibold text-ink">Belegdaten</h2>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {mode === "INVOICE" && !isEdit && (
          <EditorField label="Typ">
            {(id) => (
              <select
                id={id}
                className={inputCls}
                value={draft.type}
                onChange={(e) => dispatch({ type: "set", field: "type", value: e.target.value as DraftState["type"] })}
              >
                <option value="INVOICE">Rechnung</option>
                <option value="CREDIT_NOTE">Gutschrift</option>
              </select>
            )}
          </EditorField>
        )}

        {mode === "INVOICE" && (
          <EditorField label="Steuerschema">
            {(id) => (
              <select
                id={id}
                className={inputCls}
                value={draft.taxScheme}
                onChange={(e) => dispatch({ type: "set", field: "taxScheme", value: e.target.value as DraftState["taxScheme"] })}
              >
                <option value="REGULAR">Regelbesteuerung</option>
                <option value="KLEINUNTERNEHMER">Kleinunternehmer (§ 19)</option>
                <option value="DIFFERENZ">Differenzbesteuerung (§ 25a)</option>
                <option value="REVERSE_CHARGE">Reverse Charge (§ 13b)</option>
                <option value="IG_LIEFERUNG">Innergem. Lieferung (§ 6a)</option>
                <option value="IG_LEISTUNG">Innergem. Leistung (§ 3a Abs. 2)</option>
                <option value="AUSFUHR">Ausfuhrlieferung (§ 6)</option>
                <option value="NICHT_STEUERBAR">Nicht steuerbar, Drittland-Leistung (§ 3a Abs. 2/4/5)</option>
              </select>
            )}
          </EditorField>
        )}

        {(mode === "INVOICE" || mode === "DOCUMENT") && (
          <EditorField
            label="Währung"
            hint={displayCurrency !== "EUR" ? "Fremdwährung: kein GiroCode; bei Rechnungen werden Kurs und USt in EUR ausgewiesen (Art. 230 MwStSystRL, § 16 Abs. 6 UStG)." : undefined}
          >
            {(id) => (
              <select id={id} className={inputCls} value={displayCurrency} onChange={(e) => dispatch({ type: "set", field: "currency", value: e.target.value })}>
                {currencyOptions(displayCurrency).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
          </EditorField>
        )}

        <EditorField label="Belegsprache" hint="Sprache von PDF, XML-Hinweisen und Pflichthinweis; leer = Sprache des Kunden">
          {(id) => (
            <select id={id} className={inputCls} value={draft.language} onChange={(e) => dispatch({ type: "set", field: "language", value: e.target.value === "en" ? "en" : e.target.value === "de" ? "de" : "" })}>
              <option value="">Wie Kunde</option>
              <option value="de">Deutsch</option>
              <option value="en">English</option>
            </select>
          )}
        </EditorField>

        {mode === "INVOICE" && displayCurrency !== "EUR" && <FxPreview draft={draft} currency={displayCurrency} taxCents={taxCents} dispatch={dispatch} />}

        {mode === "INVOICE" && (
          <EditorField label="Rechnungsdatum" hint="leer = Datum der Anlage">
            {(id) => (
              <input
                id={id}
                type="date"
                className={inputCls}
                value={draft.issueDate}
                onChange={(e) => dispatch({ type: "set", field: "issueDate", value: e.target.value })}
              />
            )}
          </EditorField>
        )}

        {mode === "INVOICE" && (
          <EditorField label="Leistungsdatum">
            {(id) => (
              <div className="space-y-1.5">
                <input
                  id={id}
                  type="date"
                  className={inputCls}
                  value={draft.deliveryDate}
                  disabled={draft.deliveryDateFollowsIssue}
                  onChange={(e) => dispatch({ type: "set", field: "deliveryDate", value: e.target.value })}
                />
                <label className="flex items-center gap-2 text-xs text-ink-muted">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border-rule-strong"
                    checked={draft.deliveryDateFollowsIssue}
                    onChange={(e) => {
                      const follows = e.target.checked;
                      dispatch({
                        type: "replace",
                        state: { ...draft, deliveryDateFollowsIssue: follows, deliveryDate: follows ? issueRef : draft.deliveryDate, dirty: true },
                      });
                    }}
                  />
                  entspricht dem Rechnungsdatum
                </label>
              </div>
            )}
          </EditorField>
        )}

        {mode === "INVOICE" && (
          <EditorField label="Fällig am">
            {(id) => (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  id={id}
                  type="date"
                  className={`${inputCls} flex-1`}
                  value={draft.dueDate}
                  onChange={(e) => dispatch({ type: "set", field: "dueDate", value: e.target.value })}
                />
                <span className="text-xs text-ink-muted">in</span>
                <input
                  type="number"
                  min={0}
                  max={365}
                  aria-label="Fällig in Tagen"
                  className={`${inputCls} w-20`}
                  value={dueDaysFrom(issueRef, draft.dueDate)}
                  onChange={(e) => dispatch({ type: "set", field: "dueDate", value: dueDateFromDays(issueRef, e.target.value) })}
                />
                <span className="text-xs text-ink-muted">Tagen</span>
              </div>
            )}
          </EditorField>
        )}

        {mode === "INVOICE" && (
          <EditorField label="Zahlungsmethode">
            {(id) => (
              <select id={id} className={inputCls} value={draft.paymentMethodId} onChange={(e) => dispatch({ type: "set", field: "paymentMethodId", value: e.target.value })}>
                <option value="">— keine —</option>
                {paymentMethods.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            )}
          </EditorField>
        )}

        {mode === "INVOICE" && selectedMethod?.untdidCode && CARD_CODES.has(selectedMethod.untdidCode) && (
          <>
            <EditorField label="Kartennetz">
              {(id) => (
                <>
                  <input
                    id={id}
                    className={inputCls}
                    list="card-network-suggestions"
                    maxLength={35}
                    autoComplete="off"
                    value={draft.cardNetwork}
                    onChange={(e) => dispatch({ type: "set", field: "cardNetwork", value: e.target.value })}
                  />
                  <datalist id="card-network-suggestions">
                    {CARD_NETWORK_SUGGESTIONS.map((n) => (
                      <option key={n} value={n} />
                    ))}
                  </datalist>
                </>
              )}
            </EditorField>
            <EditorField label="Letzte 4 Ziffern">
              {(id) => (
                <input
                  id={id}
                  className={inputCls}
                  inputMode="numeric"
                  maxLength={19}
                  autoComplete="off"
                  value={draft.cardPanTruncated}
                  onChange={(e) => dispatch({ type: "set", field: "cardPanTruncated", value: e.target.value })}
                />
              )}
            </EditorField>
            <EditorField label="Karteninhaber">
              {(id) => (
                <input
                  id={id}
                  className={inputCls}
                  maxLength={70}
                  autoComplete="off"
                  value={draft.cardHolderName}
                  onChange={(e) => dispatch({ type: "set", field: "cardHolderName", value: e.target.value })}
                />
              )}
            </EditorField>
          </>
        )}

        {mode === "INVOICE" && selectedMethod?.untdidCode === "59" && (
          <p className="text-xs text-ink-muted">Mandat und Gläubiger-ID werden beim Festschreiben übernommen.</p>
        )}

        {mode === "DOCUMENT" && !isEdit && (
          <EditorField label="Art">
            {(id) => (
              <select id={id} className={inputCls} value={draft.kind} onChange={(e) => dispatch({ type: "set", field: "kind", value: e.target.value as DraftState["kind"] })}>
                <option value="ANGEBOT">Angebot</option>
                <option value="AUFTRAGSBESTAETIGUNG">Auftragsbestätigung</option>
                <option value="PROFORMA">Proforma-Rechnung</option>
              </select>
            )}
          </EditorField>
        )}

        {mode === "DOCUMENT" && (
          <EditorField label="Gültig bis" hint="optional">
            {(id) => <input id={id} type="date" className={inputCls} value={draft.validUntil} onChange={(e) => dispatch({ type: "set", field: "validUntil", value: e.target.value })} />}
          </EditorField>
        )}

        {mode === "DOCUMENT" && (
          <EditorField label="Kundenreferenz / Bestellnummer">
            {(id) => <input id={id} className={inputCls} value={draft.customerReference} onChange={(e) => dispatch({ type: "set", field: "customerReference", value: e.target.value })} />}
          </EditorField>
        )}

        {mode === "DELIVERY_NOTE" && (
          <EditorField label="Lieferdatum" hint="optional">
            {(id) => <input id={id} type="date" className={inputCls} value={draft.deliveryDate} onChange={(e) => dispatch({ type: "set", field: "deliveryDate", value: e.target.value })} />}
          </EditorField>
        )}

        {mode === "DELIVERY_NOTE" && (
          <EditorField label="Versanddatum" hint="optional">
            {(id) => <input id={id} type="date" className={inputCls} value={draft.shippingDate} onChange={(e) => dispatch({ type: "set", field: "shippingDate", value: e.target.value })} />}
          </EditorField>
        )}

        {(mode === "INVOICE" || mode === "DOCUMENT") && (
          <EditorField label="Betreff">
            {(id) => <input id={id} className={inputCls} value={draft.subject} onChange={(e) => dispatch({ type: "set", field: "subject", value: e.target.value })} />}
          </EditorField>
        )}
      </div>
    </div>
  );
}
