/**
 * Anlegen/Aendern eines Kunden (Contact) — EINZIGE Domain-Funktion fuer Server-Action
 * (`saveCustomer`, src/app/actions/masterdata.ts), MCP-Tools (`upsert_customer`/
 * `update_customer`, src/mcp/tools/customers.ts) und die REST-API (POST/PATCH
 * /api/v1/Contact). Fix-Runde 1 zu Phase 10 Task 2 (Koordinator-Ruling a, 2026-09-04):
 * vorher war dieselbe Anlage-/Aenderungslogik (customerSchema-Feldliste + Nummernkreis
 * + defaultPaymentMethodId-Mandantenpruefung) DREIFACH dupliziert — jetzt einzige Quelle.
 *
 * `updateCustomer` folgt PATCH-Semantik: nur die im `rawInput` TATSAECHLICH vorhandenen
 * Schluessel werden geschrieben (Object.keys(raw)), ungenannte Felder bleiben
 * unveraendert. Ein paar optionale String-Felder werden dabei auf `null` normalisiert,
 * wenn sie als Schluessel vorhanden, aber leer/undefined sind (nullableOnEmpty) — das
 * bildet exakt das bisherige Verhalten der Server-Action nach (ein leeres Formularfeld
 * loescht den bestehenden Wert), waehrend ein Aufrufer, der den Schluessel komplett
 * WEGLAESST (REST-PATCH, MCP `update_customer`), das Feld unangetastet laesst.
 * `customerNumber` wird nur geschrieben, wenn NICHT-leer angegeben (eine bereits
 * vergebene Nummer bleibt sonst beim Speichern anderer Felder erhalten).
 */
import { dbInternal } from "@/lib/db";
import { customerSchema, customerFieldsSchema, customerEndpointProblems, customerDirectDebitProblems, type CustomerInput } from "@/schemas";
import { isValidLeitwegId } from "@/lib/einvoice/eas";
import { normalizeVatId } from "@/lib/vat-id";
import { assignCustomerNumber } from "@/domain/numbering/ranges";
import { NotFoundError } from "@/domain/errors";
import type { Customer, Prisma } from "@/generated/prisma/client";

/** defaultPaymentMethodId zeigt auf eine Zahlungsmethode einer ANDEREN Organisation
 *  oder gar nicht existent — Validierungsfehler (400 im API-Kontext), kein Serverfehler. */
export class CustomerValidationError extends Error {
  /** Feld, an dem die Meldung haengt (REST: Pfad der Validierungsfrage); ohne Angabe: defaultPaymentMethodId. */
  readonly path: string | undefined;
  constructor(message: string, path?: string) {
    super(message);
    this.name = "CustomerValidationError";
    this.path = path;
  }
}

function toCreateData(v: CustomerInput) {
  return {
    type: v.type,
    name: v.name,
    contactName: v.contactName ?? null,
    addressLine1: v.addressLine1,
    addressLine2: v.addressLine2 ?? null,
    postalCode: v.postalCode,
    city: v.city,
    countryCode: v.countryCode,
    email: v.email || null,
    phone: v.phone ?? null,
    vatId: v.vatId ?? null,
    leitwegId: v.leitwegId ?? null,
    peppolId: v.peppolId ?? null,
    peppolScheme: v.peppolId ? (v.peppolScheme ?? null) : null,
    legalRegistrationId: v.legalRegistrationId || null,
    defaultPaymentTermsDays: v.defaultPaymentTermsDays ?? null,
    defaultPaymentMethodId: v.defaultPaymentMethodId ?? null,
    notes: v.notes ?? null,
    deliveryChannel: v.deliveryChannel ?? "EMAIL",
    sepaMandateReference: v.sepaMandateReference || null,
    sepaMandateSignedAt: v.sepaMandateSignedAt ?? null,
    sepaDebitIban: v.sepaDebitIban || null,
    sepaDebitAccountName: v.sepaDebitAccountName || null,
  };
}

/** G (Fix-Welle Phase 8a/Task 1): defaultPaymentMethodId ungeprueft haette eine
 *  Zahlungsmethode einer FREMDEN Organisation eintragen lassen (Prisma prueft nur
 *  Existenz der ID, nicht orgId). */
async function assertPaymentMethodBelongsToOrg(orgId: string, defaultPaymentMethodId: string | null | undefined): Promise<void> {
  if (!defaultPaymentMethodId) return;
  const method = await dbInternal.paymentMethod.findFirst({ where: { id: defaultPaymentMethodId, orgId }, select: { id: true } });
  if (!method) throw new CustomerValidationError("Zahlungsmethode nicht gefunden.");
}

/** Leitweg-ID nur pruefen, wenn neu oder geaendert (Bestandswerte bleiben speicherbar). */
function assertLeitwegId(next: string | null | undefined, current: string | null): void {
  const value = next?.trim();
  if (!value || value === current) return;
  if (!isValidLeitwegId(value)) throw new CustomerValidationError("Ungültige Leitweg-ID (Format oder Prüfziffer).");
}

/** Vorpruefung einer Neuanlage ausserhalb der Datenbank (Leitweg-ID); wirft CustomerValidationError. */
export function assertCustomerCreatable(v: CustomerInput): void {
  assertLeitwegId(v.leitwegId, null);
}

/** Legt einen Kunden in einer bestehenden Transaktion an (Kundennummer per Nummernkreis, falls leer). */
export async function createCustomerWithinTx(tx: Prisma.TransactionClient, orgId: string, v: CustomerInput): Promise<Customer> {
  const data = toCreateData(v);
  const customerNumber = v.customerNumber ?? (await assignCustomerNumber(tx, orgId));
  return tx.customer.create({ data: { ...data, customerNumber, orgId } });
}

/** Legt einen neuen Kunden an. Kundennummer per Nummernkreis (CUSTOMER), sofern im
 *  Input nicht bereits gesetzt (§34). */
export async function createCustomer(orgId: string, rawInput: unknown): Promise<Customer> {
  const v = customerSchema.parse(rawInput);
  assertCustomerCreatable(v);
  await assertPaymentMethodBelongsToOrg(orgId, v.defaultPaymentMethodId);
  return dbInternal.$transaction((tx) => createCustomerWithinTx(tx, orgId, v));
}

const NULLABLE_ON_EMPTY = new Set(["contactName", "addressLine2", "phone", "vatId", "leitwegId", "peppolId", "peppolScheme", "legalRegistrationId", "notes", "defaultPaymentMethodId", "defaultPaymentTermsDays", "sepaMandateReference", "sepaMandateSignedAt", "sepaDebitIban", "sepaDebitAccountName"]);

const DIRECT_DEBIT_KEYS = ["sepaMandateReference", "sepaMandateSignedAt", "sepaDebitIban", "sepaDebitAccountName"] as const;

export async function updateCustomer(orgId: string, id: string, rawInput: unknown): Promise<Customer> {
  const raw = rawInput && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {};
  const v = customerFieldsSchema.partial().parse(raw);

  const existing = await dbInternal.customer.findFirst({ where: { id, orgId } });
  if (!existing) throw new NotFoundError("Kunde nicht gefunden.");

  if ("defaultPaymentMethodId" in raw) {
    await assertPaymentMethodBelongsToOrg(orgId, v.defaultPaymentMethodId);
  }

  if ("leitwegId" in raw) assertLeitwegId(v.leitwegId, existing.leitwegId);
  if ("peppolId" in raw || "peppolScheme" in raw) {
    const peppolId = "peppolId" in raw ? v.peppolId : existing.peppolId;
    const peppolScheme = "peppolScheme" in raw ? v.peppolScheme : existing.peppolScheme;
    const problem = customerEndpointProblems({ peppolId, peppolScheme })[0];
    if (problem) throw new CustomerValidationError(problem.message);
  }

  let clearMandate = false;
  if (DIRECT_DEBIT_KEYS.some((k) => k in raw)) {
    // Mandat als Paar auf dem gemergten Zustand pruefen (Bestand + Aenderung); Meldungen ohne Werte.
    const pick = <T>(key: (typeof DIRECT_DEBIT_KEYS)[number], current: T): T | null | undefined =>
      key in raw ? ((v as Record<string, unknown>)[key] as T | null | undefined) : current;
    const merged = {
      sepaMandateReference: pick("sepaMandateReference", existing.sepaMandateReference),
      sepaMandateSignedAt: pick("sepaMandateSignedAt", existing.sepaMandateSignedAt),
      sepaDebitIban: pick("sepaDebitIban", existing.sepaDebitIban),
      sepaDebitAccountName: pick("sepaDebitAccountName", existing.sepaDebitAccountName),
    };
    // Referenz UND IBAN ausdruecklich geleert = Mandat entfernt: Datum und Kontoinhaber gehen mit.
    clearMandate = "sepaMandateReference" in raw && "sepaDebitIban" in raw && !merged.sepaMandateReference?.trim() && !merged.sepaDebitIban?.trim();
    if (clearMandate) {
      // Mandat entfernen und zugleich Datum/Kontoinhaber mitschicken: widerspruechlich, nicht still verwerfen.
      if (v.sepaMandateSignedAt) throw new CustomerValidationError("Zum Entfernen des Mandats darf kein Unterschriftsdatum angegeben werden.", "sepaMandateSignedAt");
      if (v.sepaDebitAccountName?.trim()) throw new CustomerValidationError("Zum Entfernen des Mandats darf kein Kontoinhaber angegeben werden.", "sepaDebitAccountName");
    } else {
      const problem = customerDirectDebitProblems(merged)[0];
      if (problem) throw new CustomerValidationError(problem.message, problem.path);
    }
  }

  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (!(key in v)) continue;
    let value = (v as Record<string, unknown>)[key];
    if (key === "email") {
      value = value || null;
    } else if (key === "customerNumber") {
      if (!value) continue; // nur schreiben, wenn nicht-leer angegeben
    } else if (NULLABLE_ON_EMPTY.has(key)) {
      value = value === "" ? null : (value ?? null);
    }
    patch[key] = value;
  }
  if (clearMandate) {
    patch.sepaMandateSignedAt = null;
    patch.sepaDebitAccountName = null;
  }
  // Ohne Peppol-ID kein Schema; geaenderte USt-IdNr. verliert die VIES-Bestaetigung.
  if ("peppolId" in patch && !patch.peppolId) patch.peppolScheme = null;
  if ("vatId" in patch) {
    const norm = (x: string | null | undefined) => (x ? normalizeVatId(x) : null);
    if (norm(patch.vatId as string | null) !== norm(existing.vatId)) patch.vatIdValidatedAt = null;
  }
  return dbInternal.customer.update({ where: { id: existing.id }, data: patch });
}
