/**
 * Kunden-Import (Phase 18b): Zeile -> Eingabe, Pruefung mit dem bestehenden Anlage-Schema
 * (`customerSchema`) und den Domainpruefungen, Duplikaterkennung gegen Bestand (inkl. archivierter
 * Kunden) und gegen frueher in der Datei. Kein Update bestehender Kunden. `orgId` kommt nur vom Aufrufer.
 */
import type { Prisma } from "@/generated/prisma/client";
import type { dbInternal } from "@/lib/db";
import { customerSchema, type CustomerInput } from "@/schemas";
import { assertCustomerCreatable, CustomerValidationError } from "@/domain/customer/save";
import { CONTACT_IMPORT_COLUMNS, parseCustomerTypeCell, parseIntCell } from "./columns";
import { cellValue, controlCharProblems, headerOf, zodProblems, type ColumnIndex, type ImportRowError, type ParsedRow, type RowProblem } from "./types";

export type ImportDb = Prisma.TransactionClient | typeof dbInternal;

const KEY_MAP: Record<string, string> = {
  contactName: "contactPerson",
  addressLine1: "street",
  addressLine2: "addressExtra",
  countryCode: "country",
  legalRegistrationId: "registerNumber",
  defaultPaymentTermsDays: "paymentTermDays",
};

const h = (key: string) => headerOf(CONTACT_IMPORT_COLUMNS, key);

export function contactRowToInput(cells: readonly string[], index: ColumnIndex): { input: Record<string, unknown> } | { errors: RowProblem[] } {
  const errors: RowProblem[] = [];
  const get = (key: string) => cellValue(cells, index, key);
  const input: Record<string, unknown> = {
    name: get("name"),
    contactName: get("contactPerson"),
    addressLine1: get("street"),
    addressLine2: get("addressExtra"),
    postalCode: get("postalCode"),
    city: get("city"),
    countryCode: get("country")?.toUpperCase(),
    email: get("email"),
    phone: get("phone"),
    vatId: get("vatId"),
    leitwegId: get("leitwegId"),
    peppolId: get("peppolId"),
    peppolScheme: get("peppolScheme"),
    legalRegistrationId: get("registerNumber"),
    customerNumber: get("customerNumber"),
  };
  const type = parseCustomerTypeCell(get("customerType") ?? "");
  if (type === null) errors.push({ column: h("customerType"), message: "Ungültiger Kundentyp (Firma oder Privat)" });
  else input.type = type;
  const terms = get("paymentTermDays");
  if (terms !== undefined) {
    const n = parseIntCell(terms, 0, 365);
    if (n === null) errors.push({ column: h("paymentTermDays"), message: "Zahl von 0 bis 365 erwartet" });
    else input.defaultPaymentTermsDays = n;
  }
  return errors.length > 0 ? { errors } : { input };
}

export interface ValidatedRows<T> {
  valid: { line: number; value: T }[];
  errors: ImportRowError[];
  /** Bestehende plus in der Datei ausdruecklich angegebene Nummern (fuer die Nummernkreis-Kollisionspruefung). */
  taken: Set<string>;
}

export interface ContactInputError {
  ref: number;
  /** Schemafeld (`customerSchema`), `null` bei feldlosen Fehlern. */
  field: string | null;
  message: string;
}

export interface ValidateContactInputsOptions {
  /** Verweis auf den ersten Datensatz in Meldungen zu Duplikaten in derselben Eingabe (Standard: "Zeile n"). */
  refLabel?: (ref: number) => string;
}

/**
 * Gemeinsame Pruefung fuer CSV-Import (Phase 18b) und Sammelanlage (18d): Schema (`customerSchema`), Domainpruefung
 * (Leitweg-ID), Zahlungsmethode der eigenen Organisation, Duplikate gegen Bestand (inkl. archivierter Kunden) und
 * innerhalb der Eingabe. `input` ist schemanah (Feldnamen von `customerSchema`); unbekannte Schluessel (z. B. `orgId`, `id`)
 * werden vom Schema verworfen. Meldungen enthalten nie Eingabewerte.
 */
export async function validateContactInputs(
  db: ImportDb,
  orgId: string,
  items: readonly { ref: number; input: Record<string, unknown> }[],
  options: ValidateContactInputsOptions = {},
): Promise<{ valid: { ref: number; value: CustomerInput }[]; errors: ContactInputError[] }> {
  const refLabel = options.refLabel ?? ((ref: number) => `Zeile ${ref}`);
  const existing = await db.customer.findMany({ where: { orgId }, select: { customerNumber: true, name: true, email: true } });
  const numbers = new Set<string>();
  const emailName = new Set<string>();
  for (const c of existing) {
    if (c.customerNumber) numbers.add(c.customerNumber);
    if (c.email) emailName.add(`${c.email.toLowerCase()}\u0000${c.name.toLowerCase()}`);
  }
  const methodIds = [...new Set(items.flatMap((it) => (typeof it.input.defaultPaymentMethodId === "string" && it.input.defaultPaymentMethodId ? [it.input.defaultPaymentMethodId] : [])))];
  const ownMethods = new Set(
    methodIds.length === 0 ? [] : (await db.paymentMethod.findMany({ where: { orgId, id: { in: methodIds } }, select: { id: true } })).map((m) => m.id),
  );
  const seenNumber = new Map<string, number>();
  const seenEmailName = new Map<string, number>();
  const valid: { ref: number; value: CustomerInput }[] = [];
  const errors: ContactInputError[] = [];

  for (const item of items) {
    const problems: { field: string | null; message: string }[] = [];
    let value: CustomerInput | null = null;
    const parsed = customerSchema.safeParse(item.input);
    if (!parsed.success) {
      // Spalten-Liste leer: `column` ist dann der Schemafeldname selbst.
      for (const p of zodProblems(parsed.error, [], {}, ["countryCode"], item.input)) problems.push({ field: p.column === "" ? null : p.column, message: p.message });
    } else {
      try {
        assertCustomerCreatable(parsed.data);
        value = parsed.data;
      } catch (e) {
        if (!(e instanceof CustomerValidationError)) throw e;
        problems.push({ field: "leitwegId", message: e.message });
      }
    }
    if (value?.defaultPaymentMethodId && !ownMethods.has(value.defaultPaymentMethodId)) {
      problems.push({ field: "defaultPaymentMethodId", message: "Zahlungsmethode nicht gefunden." });
    }
    if (value) {
      const num = value.customerNumber?.trim();
      if (num) {
        const first = seenNumber.get(num);
        if (numbers.has(num)) problems.push({ field: "customerNumber", message: "Kundennummer bereits vergeben" });
        else if (first !== undefined) problems.push({ field: "customerNumber", message: `Kundennummer doppelt in ${refLabel(first)}` });
        else seenNumber.set(num, item.ref);
      }
      if (value.email) {
        const key = `${value.email.toLowerCase()}\u0000${value.name.toLowerCase()}`;
        const first = seenEmailName.get(key);
        if (emailName.has(key)) problems.push({ field: "email", message: "Kunde mit gleicher E-Mail und gleichem Namen vorhanden" });
        else if (first !== undefined) problems.push({ field: "email", message: `Kunde mit gleicher E-Mail und gleichem Namen doppelt in ${refLabel(first)}` });
        else seenEmailName.set(key, item.ref);
      }
    }
    if (problems.length > 0 || !value) for (const p of problems) errors.push({ ref: item.ref, field: p.field, message: p.message });
    else valid.push({ ref: item.ref, value });
  }
  return { valid, errors };
}

/** Schemafeld -> CSV-Spaltenkopf (Fehlermeldungen des Imports). */
function columnOfField(field: string | null): string {
  return field === null ? "" : h(KEY_MAP[field] ?? field);
}

/** Bestehende plus ausdruecklich angegebene Kundennummern (fuer die Nummernkreis-Kollisionspruefung). */
export async function takenNumbers(db: ImportDb, orgId: string, values: readonly CustomerInput[]): Promise<Set<string>> {
  const existing = await db.customer.findMany({ where: { orgId }, select: { customerNumber: true } });
  const taken = new Set<string>();
  for (const c of existing) if (c.customerNumber) taken.add(c.customerNumber);
  for (const v of values) {
    const n = v.customerNumber?.trim();
    if (n) taken.add(n);
  }
  return taken;
}

export async function validateContactRows(db: ImportDb, orgId: string, rows: readonly ParsedRow[], index: ColumnIndex): Promise<ValidatedRows<CustomerInput>> {
  const mappedItems: { ref: number; input: Record<string, unknown> }[] = [];
  const rowErrors = new Map<number, RowProblem[]>();
  for (const row of rows) {
    const control = controlCharProblems(row.cells, index, CONTACT_IMPORT_COLUMNS);
    const mapped = control.length > 0 ? { errors: control } : contactRowToInput(row.cells, index);
    if ("errors" in mapped) rowErrors.set(row.line, mapped.errors);
    else mappedItems.push({ ref: row.line, input: mapped.input });
  }
  const res = await validateContactInputs(db, orgId, mappedItems);
  const byLine = new Map<number, ImportRowError[]>();
  for (const e of res.errors) {
    const list = byLine.get(e.ref) ?? [];
    list.push({ line: e.ref, column: columnOfField(e.field), message: e.message });
    byLine.set(e.ref, list);
  }
  const errors: ImportRowError[] = [];
  for (const row of rows) {
    for (const p of rowErrors.get(row.line) ?? []) errors.push({ line: row.line, column: p.column, message: p.message });
    errors.push(...(byLine.get(row.line) ?? []));
  }
  const valid = res.valid.map((v) => ({ line: v.ref, value: v.value }));
  return { valid, errors, taken: await takenNumbers(db, orgId, valid.map((v) => v.value)) };
}
