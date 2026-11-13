/**
 * CSV-Spalten fuer Stammdaten (Phase 18b, Task 2): Kunden und Produkte. Filter wie die
 * JSON-Listen (`contactListFilterSchema`, `productListFilterSchema`; `limit`/`offset` werden
 * ignoriert), Sortierung Name aufsteigend, dann Id. Org-Scope in jeder Abfrage. Interne Notizen
 * (`Customer.notes`) stehen in keiner Spalte. Die Kundenspalten beginnen mit den 17 Spalten, die
 * der Import (Task 4) liest.
 */
import { prisma, ciContains } from "@/lib/db";
import { contactListFilterSchema } from "@/domain/customer/list";
import { productListFilterSchema } from "@/domain/product/list";
import { listCustomFieldDefinitions, customFieldValuesFromJson, toLike } from "@/domain/customer/custom-fields";
import { col, csvTable, type CsvColumn } from "./csv-writer";
import { CUSTOMER_TYPE_LABEL, labelOf } from "./labels";
import { ExportTooLargeError } from "./errors";
import { EXPORT_ROW_LIMIT } from "./limits";

const tooLarge = (limit: number, hint?: string) => new ExportTooLargeError(limit, hint);

function fieldCell(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? "ja" : "nein";
  return String(value);
}

export async function contactsCsv(orgId: string, rawFilter: unknown, opts: { limit?: number; hint?: string } = {}): Promise<{ csv: string; rows: number }> {
  const limit = opts.limit ?? EXPORT_ROW_LIMIT;
  const filter = contactListFilterSchema.parse(rawFilter);
  const where = {
    orgId,
    ...(filter.includeArchived ? {} : { isArchived: false }),
    ...(filter.search
      ? { OR: [{ name: ciContains(filter.search) }, { customerNumber: ciContains(filter.search) }, { email: ciContains(filter.search) }] }
      : {}),
  };
  const [rows, definitions] = await Promise.all([
    prisma.customer.findMany({
      where,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: limit + 1,
      select: {
        customerNumber: true,
        type: true,
        name: true,
        contactName: true,
        addressLine1: true,
        addressLine2: true,
        postalCode: true,
        city: true,
        countryCode: true,
        email: true,
        phone: true,
        vatId: true,
        leitwegId: true,
        peppolId: true,
        peppolScheme: true,
        legalRegistrationId: true,
        defaultPaymentTermsDays: true,
        invoiceEmail: true,
        defaultCurrency: true,
        language: true,
        isArchived: true,
        createdAt: true,
        customFieldsJson: true,
      },
    }),
    listCustomFieldDefinitions(orgId, { activeOnly: true }),
  ]);
  if (rows.length > limit) throw tooLarge(limit, opts.hint);
  const likes = definitions.map(toLike);
  type R = (typeof rows)[number];
  const fieldValues = new WeakMap<R, Record<string, unknown>>();
  const valuesOf = (r: R): Record<string, unknown> => {
    let v = fieldValues.get(r);
    if (!v) {
      v = customFieldValuesFromJson(r.customFieldsJson, likes);
      fieldValues.set(r, v);
    }
    return v;
  };
  const columns: CsvColumn<R>[] = [
    col("Kundennummer", "text", (r) => r.customerNumber),
    col("Typ", "text", (r) => labelOf(CUSTOMER_TYPE_LABEL, r.type)),
    col("Name", "text", (r) => r.name),
    col("Ansprechpartner", "text", (r) => r.contactName),
    col("Straße", "text", (r) => r.addressLine1),
    col("Adresszusatz", "text", (r) => r.addressLine2),
    col("PLZ", "text", (r) => r.postalCode),
    col("Ort", "text", (r) => r.city),
    col("Land", "text", (r) => r.countryCode),
    col("E-Mail", "text", (r) => r.email),
    col("Telefon", "text", (r) => r.phone),
    col("USt-IdNr.", "text", (r) => r.vatId),
    col("Leitweg-ID", "text", (r) => r.leitwegId),
    col("Peppol-ID", "text", (r) => r.peppolId),
    col("Peppol-Schema", "text", (r) => r.peppolScheme),
    col("Registernummer", "text", (r) => r.legalRegistrationId),
    col("Zahlungsziel (Tage)", "int", (r) => r.defaultPaymentTermsDays),
    col("Rechnungs-E-Mail", "text", (r) => r.invoiceEmail),
    col("Währung", "text", (r) => r.defaultCurrency),
    col("Sprache", "text", (r) => r.language),
    col("Archiviert", "bool", (r) => r.isArchived),
    col("Angelegt am", "berlinDate", (r) => r.createdAt),
    ...likes.map((d) => col<R>(`Kundenfeld: ${d.label}`, "text", (r) => fieldCell(valuesOf(r)[d.key]))),
  ];
  return { csv: csvTable(columns, rows), rows: rows.length };
}

export async function productsCsv(orgId: string, rawFilter: unknown, opts: { limit?: number; hint?: string } = {}): Promise<{ csv: string; rows: number }> {
  const limit = opts.limit ?? EXPORT_ROW_LIMIT;
  const filter = productListFilterSchema.parse(rawFilter);
  const where = {
    orgId,
    ...(filter.includeArchived ? {} : { isArchived: false }),
    ...(filter.search ? { OR: [{ name: ciContains(filter.search) }, { articleNumber: ciContains(filter.search) }] } : {}),
  };
  const rows = await prisma.product.findMany({
    where,
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: limit + 1,
    select: {
      articleNumber: true,
      name: true,
      description: true,
      unit: true,
      netPriceCents: true,
      taxRate: true,
      taxCategory: true,
      differential: true,
      ossCategory: true,
      isArchived: true,
      createdAt: true,
    },
  });
  if (rows.length > limit) throw tooLarge(limit, opts.hint);
  type R = (typeof rows)[number];
  const columns: CsvColumn<R>[] = [
    col("Artikelnummer", "text", (r) => r.articleNumber),
    col("Bezeichnung", "text", (r) => r.name),
    col("Beschreibung", "text", (r) => r.description),
    col("Einheit", "text", (r) => r.unit),
    col("Nettopreis", "cents", (r) => r.netPriceCents),
    col("Steuersatz (%)", "int", (r) => r.taxRate),
    col("Steuerkategorie", "text", (r) => r.taxCategory),
    col("Differenzbesteuerung", "bool", (r) => r.differential),
    col("OSS-Kategorie", "text", (r) => r.ossCategory),
    col("Archiviert", "bool", (r) => r.isArchived),
    col("Angelegt am", "berlinDate", (r) => r.createdAt),
  ];
  return { csv: csvTable(columns, rows), rows: rows.length };
}
