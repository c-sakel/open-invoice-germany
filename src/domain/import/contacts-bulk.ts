/**
 * Sammelanlage von Kunden (Phase 18d, REST `POST /api/v1/Contact/bulk`, MCP `create_contacts`): 1..100 Kunden,
 * alles oder nichts. Pruefung und Anlage laufen in EINER Transaktion unter der Organisations-Sperre, mit derselben
 * Validierung wie der CSV-Import (`validateContactInputs`) und derselben Anlage-Schleife (`createContactsWithinTx`).
 * `orgId` kommt nur vom Aufrufer; `orgId`/`id` im Datensatz werden vom Schema verworfen. Fehlermeldungen und
 * Protokoll enthalten nie Namen oder E-Mail-Adressen. Rate-Limit 10/min je Organisation.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Customer } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { lockOrganization } from "@/lib/db-lock";
import { logActivity } from "@/domain/activity/log";
import { validateContactInputs, type ContactInputError } from "./contacts-import";
import { createContactsWithinTx } from "./run";
import { CONTROL_CHARS } from "./types";

export const CONTACTS_BULK_MAX = 100;
const MAX_LISTED_ERRORS = 200;
const TX_OPTIONS = { timeout: 60_000, maxWait: 10_000 } as const;

export const contactsBulkSchema = z.object({ contacts: z.array(z.record(z.string(), z.unknown())).min(1).max(CONTACTS_BULK_MAX) });

export interface ContactsBulkError {
  index: number;
  field: string | null;
  message: string;
}

export class ContactsBulkRejectedError extends Error {
  readonly status = 422;
  constructor(readonly errors: ContactsBulkError[], readonly errorCount: number = errors.length) {
    super("Sammelanlage abgelehnt: Die Daten enthalten Fehler.");
    this.name = "ContactsBulkRejectedError";
  }
}

const COLLISION_MESSAGE = "Nummer aus dem Nummernkreis bereits vergeben — Nummernkreis anpassen";

/** Felder mit Steuerzeichen (Postgres lehnt NUL ab), ohne Werte in der Meldung. */
function controlCharErrors(index: number, input: Record<string, unknown>): ContactsBulkError[] {
  const out: ContactsBulkError[] = [];
  for (const [field, v] of Object.entries(input)) {
    if (typeof v === "string" && CONTROL_CHARS.test(v)) out.push({ index, field, message: "Enthält unzulässige Steuerzeichen" });
  }
  return out;
}

export async function createContactsBulk(orgId: string, raw: unknown, ctx: { actor: string; source: "API" | "MCP" }): Promise<Customer[]> {
  rateLimit(`contacts-bulk:${orgId}`, { limit: 10, windowMs: 60_000 });
  const { contacts } = contactsBulkSchema.parse(raw);

  const customers = await dbInternal.$transaction(async (tx) => {
    await lockOrganization(tx, orgId);
    const controlErrors = contacts.flatMap((input, i) => controlCharErrors(i, input));
    const flagged = new Set(controlErrors.map((e) => e.index));
    const items = contacts.flatMap((input, i) => (flagged.has(i) ? [] : [{ ref: i, input }]));
    const r = await validateContactInputs(tx, orgId, items, { refLabel: (ref) => `Eintrag ${ref}` });
    const all: ContactsBulkError[] = [...controlErrors, ...r.errors.map((e: ContactInputError) => ({ index: e.ref, field: e.field, message: e.message }))];
    if (all.length > 0) {
      all.sort((a, b) => a.index - b.index);
      throw new ContactsBulkRejectedError(all.slice(0, MAX_LISTED_ERRORS), all.length);
    }
    const made = await createContactsWithinTx(tx, orgId, r.valid);
    if (made.collisions.length > 0) {
      throw new ContactsBulkRejectedError(made.collisions.map((index) => ({ index, field: "customerNumber", message: COLLISION_MESSAGE })));
    }
    return made.customers;
  }, TX_OPTIONS);

  await logActivity(dbInternal, {
    orgId,
    entityType: "IMPORT",
    entityId: randomUUID(),
    type: "CONTACTS_BULK_CREATED",
    actor: ctx.actor,
    data: { created: customers.length, source: ctx.source },
  });
  return customers;
}
