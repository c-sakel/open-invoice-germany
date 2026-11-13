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
import { cellValue, headerOf, zodProblems, type ColumnIndex, type ImportRowError, type ParsedRow, type RowProblem } from "./types";

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

export async function validateContactRows(db: ImportDb, orgId: string, rows: readonly ParsedRow[], index: ColumnIndex): Promise<ValidatedRows<CustomerInput>> {
  const existing = await db.customer.findMany({ where: { orgId }, select: { customerNumber: true, name: true, email: true } });
  const numbers = new Set<string>();
  const emailName = new Set<string>();
  for (const c of existing) {
    if (c.customerNumber) numbers.add(c.customerNumber);
    if (c.email) emailName.add(`${c.email.toLowerCase()}\u0000${c.name.toLowerCase()}`);
  }
  const seenNumber = new Map<string, number>();
  const seenEmailName = new Map<string, number>();
  const valid: { line: number; value: CustomerInput }[] = [];
  const errors: ImportRowError[] = [];
  const explicit = new Set<string>();

  for (const row of rows) {
    const problems: RowProblem[] = [];
    const mapped = contactRowToInput(row.cells, index);
    let value: CustomerInput | null = null;
    if ("errors" in mapped) problems.push(...mapped.errors);
    else {
      const parsed = customerSchema.safeParse(mapped.input);
      if (!parsed.success) problems.push(...zodProblems(parsed.error, CONTACT_IMPORT_COLUMNS, KEY_MAP, ["countryCode"]));
      else {
        try {
          assertCustomerCreatable(parsed.data);
          value = parsed.data;
        } catch (e) {
          if (!(e instanceof CustomerValidationError)) throw e;
          problems.push({ column: h("leitwegId"), message: e.message });
        }
      }
    }
    if (value) {
      const num = value.customerNumber?.trim();
      if (num) {
        const first = seenNumber.get(num);
        if (numbers.has(num)) problems.push({ column: h("customerNumber"), message: "Kundennummer bereits vergeben" });
        else if (first !== undefined) problems.push({ column: h("customerNumber"), message: `Kundennummer doppelt in Zeile ${first}` });
        else seenNumber.set(num, row.line);
        if (!numbers.has(num) && first === undefined) explicit.add(num);
      }
      if (value.email) {
        const key = `${value.email.toLowerCase()}\u0000${value.name.toLowerCase()}`;
        const first = seenEmailName.get(key);
        if (emailName.has(key)) problems.push({ column: h("email"), message: "Kunde mit gleicher E-Mail und gleichem Namen vorhanden" });
        else if (first !== undefined) problems.push({ column: h("email"), message: `Kunde mit gleicher E-Mail und gleichem Namen doppelt in Zeile ${first}` });
        else seenEmailName.set(key, row.line);
      }
    }
    if (problems.length > 0 || !value) for (const p of problems) errors.push({ line: row.line, column: p.column, message: p.message });
    else valid.push({ line: row.line, value });
  }
  return { valid, errors, taken: new Set([...numbers, ...explicit]) };
}
