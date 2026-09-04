/**
 * Serialisierer fuer Contact (=Customer), ContactAddress, ContactPerson
 * (Phase 10, Task 2, task-2-facts.md Registry).
 */
import { iso } from "./common";
import type { Customer, CustomerAddress, ContactPerson as ContactPersonRow } from "@/generated/prisma/client";

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
    defaultPaymentTermsDays: c.defaultPaymentTermsDays,
    defaultPaymentMethodId: c.defaultPaymentMethodId,
    customerNumber: c.customerNumber,
    notes: c.notes,
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
