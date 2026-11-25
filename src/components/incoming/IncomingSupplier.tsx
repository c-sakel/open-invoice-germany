"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createContactFromIncomingAction, updateIncomingAction } from "@/app/eingang/actions";
import { CustomerPicker } from "@/components/editor/CustomerPicker";
import { Button } from "@/components/ui/Button";
import { inputCls } from "@/components/forms/fields";
import { CONTACT_FIELD_LABELS } from "./incoming-ui";

export interface SupplierContactView {
  id: string;
  name: string;
  customerNumber: string | null;
}

export interface SupplierSuggestionView extends SupplierContactView {
  vatId: string | null;
  match: "VAT_ID" | "NAME";
}

interface Props {
  id: string;
  /** Zuordnung ist nur in den Status Neu und Geprüft änderbar. */
  editable: boolean;
  contact: SupplierContactView | null;
  suggestions: SupplierSuggestionView[];
}

const FIELD_ORDER = ["name", "addressLine1", "postalCode", "city", "countryCode", "email", "vatId"] as const;

/** Lieferant: Zuordnung zu einem Kontakt, Vorschläge (USt-IdNr., dann Name), Suche und Anlegen aus den Angaben der Rechnung. */
export function IncomingSupplier({ id, editable, contact, suggestions }: Props) {
  const router = useRouter();
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{ missing: string[]; values: Record<string, string> } | null>(null);

  async function assign(contactId: string | null) {
    setBusy(true);
    setError(null);
    try {
      const r = await updateIncomingAction(id, { supplierContactId: contactId });
      if (!r.ok) setError(r.error);
      else {
        setPick("");
        router.refresh();
      }
    } catch {
      setError("Die Zuordnung konnte nicht gespeichert werden.");
    } finally {
      setBusy(false);
    }
  }

  async function create(values: Record<string, string>) {
    setBusy(true);
    setError(null);
    const input: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) if (v.trim() !== "") input[k] = v.trim();
    try {
      const r = await createContactFromIncomingAction(id, input);
      if (r.ok) {
        setForm(null);
        router.refresh();
      } else if (r.missing && r.missing.length > 0) {
        setForm({ missing: r.missing, values: { ...(r.prefill ?? {}), ...values } });
        setError(`${r.error} Bitte die markierten Felder ergänzen.`);
      } else setError(r.error);
    } catch {
      setError("Der Kontakt konnte nicht angelegt werden.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Lieferant" className="space-y-3 rounded-md border border-rule bg-paper p-4 text-sm">
      <h2 className="text-base font-medium text-ink">Lieferant</h2>
      {contact ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 break-words text-ink">
            Zugeordnet:{" "}
            <Link href={`/kunden/${contact.id}`} className="font-medium underline">
              {contact.name}
            </Link>
            {contact.customerNumber ? <span className="text-ink-soft"> ({contact.customerNumber})</span> : null}
          </p>
          {editable ? (
            <Button variant="quiet" size="sm" disabled={busy} onClick={() => void assign(null)}>
              Zuordnung lösen
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="text-ink-soft">Noch keinem Kontakt zugeordnet.</p>
      )}
      {!editable ? <p className="text-xs text-ink-muted">Die Zuordnung ist gesperrt — zuerst zurücksetzen.</p> : null}

      {editable && !contact ? (
        <div className="space-y-3">
          {suggestions.length > 0 ? (
            <div>
              <p className="font-medium text-ink-soft">Vorschläge</p>
              <ul className="mt-1 space-y-1">
                {suggestions.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-rule bg-sheet px-3 py-2">
                    <span className="min-w-0 break-words">
                      {s.name}
                      {s.customerNumber ? <span className="text-ink-soft"> ({s.customerNumber})</span> : null}
                      <span className="block text-xs text-ink-muted">{s.match === "VAT_ID" ? "gleiche USt-IdNr." : "ähnlicher Name"}</span>
                    </span>
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => void assign(s.id)}>
                      Zuordnen
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="space-y-2">
            <p className="font-medium text-ink-soft">Kontakt suchen</p>
            <CustomerPicker label="Kontakt suchen" value={pick} onChange={(ctx) => setPick(ctx.customer.id)} disabled={busy} />
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" disabled={busy || pick === ""} onClick={() => void assign(pick)}>
                Gewählten Kontakt zuordnen
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => void create({})}>
                Als Kontakt anlegen
              </Button>
            </div>
          </div>

          {form ? (
            <form
              className="space-y-2 rounded-md border border-rule bg-sheet p-3"
              onSubmit={(e) => {
                e.preventDefault();
                void create(form.values);
              }}
            >
              <p className="font-medium text-ink-soft">Angaben für den neuen Kontakt</p>
              {FIELD_ORDER.map((f) => {
                const missing = form.missing.includes(f);
                return (
                  <label key={f} className="flex flex-col gap-1">
                    <span className={missing ? "font-medium text-red-900" : "text-ink-soft"}>
                      {CONTACT_FIELD_LABELS[f]}
                      {missing ? " (fehlt)" : ""}
                    </span>
                    <input
                      className={`${inputCls} ${missing ? "border-red-400" : ""}`}
                      value={form.values[f] ?? ""}
                      maxLength={f === "countryCode" ? 2 : 200}
                      aria-invalid={missing}
                      onChange={(e) => setForm({ ...form, values: { ...form.values, [f]: f === "countryCode" ? e.target.value.toUpperCase() : e.target.value } })}
                    />
                  </label>
                );
              })}
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" type="submit" disabled={busy}>
                  Kontakt anlegen und zuordnen
                </Button>
                <Button variant="quiet" onClick={() => setForm(null)}>
                  Abbrechen
                </Button>
              </div>
            </form>
          ) : null}
        </div>
      ) : null}
      <p role="alert" className={error ? "rounded-md border border-red-300 bg-red-50 px-3 py-2 text-red-900" : "sr-only"}>
        {error}
      </p>
    </section>
  );
}
