/**
 * Serialisierer fuer Contact (=Customer), ContactAddress, ContactPerson
 * (Phase 10, Task 2, task-2-facts.md Registry).
 */
import "../openapi-zod-init"; // Fix-Runde 1: MUSS vor jedem z.object()-Aufruf hier stehen
import { iso } from "./common";
import { maskIban } from "@/lib/iban";
import { berlinDateKey } from "@/lib/berlin-time";
import type { Customer, CustomerAddress, ContactPerson as ContactPersonRow } from "@/generated/prisma/client";
import { z } from "zod";

export function serializeContact(c: Customer) {
  return {
    objectName: "Contact" as const,
    id: c.id,
    type: c.type,
    name: c.name,
    contactName: c.contactName,
    addressLine1: c.addressLine1,
    addressLine2: c.addressLine2,
    postalCode: c.postalCode,
    city: c.city,
    countryCode: c.countryCode,
    email: c.email,
    phone: c.phone,
    vatId: c.vatId,
    leitwegId: c.leitwegId,
    peppolId: c.peppolId,
    peppolScheme: c.peppolScheme,
    legalRegistrationId: c.legalRegistrationId,
    vatIdValidatedAt: iso(c.vatIdValidatedAt),
    defaultPaymentTermsDays: c.defaultPaymentTermsDays,
    defaultPaymentMethodId: c.defaultPaymentMethodId,
    customerNumber: c.customerNumber,
    notes: c.notes,
    deliveryChannel: c.deliveryChannel,
    sepaMandateReference: c.sepaMandateReference,
    sepaMandateSignedAt: c.sepaMandateSignedAt ? berlinDateKey(c.sepaMandateSignedAt) : null,
    // Nie die volle IBAN ausgeben (Eingabe: sepaDebitIban, Ausgabe nur maskiert).
    sepaDebitIbanMasked: c.sepaDebitIban ? maskIban(c.sepaDebitIban) : null,
    sepaDebitAccountName: c.sepaDebitAccountName,
    isArchived: c.isArchived,
    createdAt: iso(c.createdAt),
    updatedAt: iso(c.updatedAt),
    // internalNotes existiert bei Customer nicht (nur `notes`) — bewusst kein Feld ausgelassen.
  };
}

export function serializeContactAddress(a: CustomerAddress) {
  return {
    objectName: "ContactAddress" as const,
    id: a.id,
    contactId: a.customerId,
    type: a.type,
    label: a.label,
    addressLine1: a.addressLine1,
    addressLine2: a.addressLine2,
    postalCode: a.postalCode,
    city: a.city,
    countryCode: a.countryCode,
    isDefault: a.isDefault,
    createdAt: iso(a.createdAt),
    updatedAt: iso(a.updatedAt),
  };
}

export function serializeContactPerson(p: ContactPersonRow) {
  return {
    objectName: "ContactPerson" as const,
    id: p.id,
    contactId: p.customerId,
    firstName: p.firstName,
    lastName: p.lastName,
    role: p.role,
    phone: p.phone,
    mobile: p.mobile,
    email: p.email,
    isDefault: p.isDefault,
    createdAt: iso(p.createdAt),
    updatedAt: iso(p.updatedAt),
  };
}


/**
 * OpenAPI-Response-Schemas (Phase 10, Task 4, task-4-facts.md): aus serializeContact/
 * serializeContactAddress/serializeContactPerson abgeleitet — muessen bei jeder
 * Feldaenderung an den Serialisierern mitgepflegt werden (kein automatischer Abgleich).
 */
export const contactSchema = z.object({
  objectName: z.literal("Contact"),
  id: z.string(),
  type: z.string(),
  name: z.string(),
  contactName: z.string().nullable(),
  addressLine1: z.string(),
  addressLine2: z.string().nullable(),
  postalCode: z.string(),
  city: z.string(),
  countryCode: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  vatId: z.string().nullable(),
  leitwegId: z.string().nullable(),
  peppolId: z.string().nullable(),
  peppolScheme: z.string().nullable(),
  legalRegistrationId: z.string().nullable(),
  vatIdValidatedAt: z.string().nullable(),
  defaultPaymentTermsDays: z.number().int().nullable(),
  defaultPaymentMethodId: z.string().nullable(),
  customerNumber: z.string().nullable(),
  notes: z.string().nullable(),
  deliveryChannel: z.string(),
  sepaMandateReference: z.string().nullable().describe("SEPA-Mandatsreferenz (BT-89); nur zusammen mit sepaDebitIban."),
  sepaMandateSignedAt: z.string().nullable().describe("Datum der Mandatsunterschrift (YYYY-MM-DD)."),
  sepaDebitIbanMasked: z.string().nullable().describe("Belastetes Konto maskiert (z. B. DE02 **** 2051); die volle IBAN wird nie ausgegeben."),
  sepaDebitAccountName: z.string().nullable().describe("Kontoinhaber des belasteten Kontos."),
  isArchived: z.boolean(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export const contactAddressSchema = z.object({
  objectName: z.literal("ContactAddress"),
  id: z.string(),
  contactId: z.string(),
  type: z.string(),
  label: z.string().nullable(),
  addressLine1: z.string(),
  addressLine2: z.string().nullable(),
  postalCode: z.string(),
  city: z.string(),
  countryCode: z.string(),
  isDefault: z.boolean(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export const contactPersonSchema = z.object({
  objectName: z.literal("ContactPerson"),
  id: z.string(),
  contactId: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  role: z.string().nullable(),
  phone: z.string().nullable(),
  mobile: z.string().nullable(),
  email: z.string().nullable(),
  isDefault: z.boolean(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
