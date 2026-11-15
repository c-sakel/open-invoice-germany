/**
 * Benachrichtigungen zu den Umsatzgrenzen der Kleinunternehmerregelung (`checkKuNotifications`,
 * Job, Hooks nach Festschreiben und Zahlung). Testjahr 2229 (Invoice.number global eindeutig).
 */
import { describe, it, expect } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { recordPayment } from "@/domain/invoice/payment";
import { ALL_NOTIFICATION_TYPES, saveNotificationSettings, type NotificationType } from "@/domain/notifications/settings";
import { runNotificationsJob } from "@/domain/notifications/job";
import { checkKuNotifications } from "@/domain/reporting/ku-notify";
import { KU_NOTICE } from "@/schemas/small-business";
import { createInvoiceSchema } from "@/schemas";

const NOW = new Date("2229-06-01T10:00:00.000Z");
const CUSTOMER_NAME = "Geheimkunde Beispiel AG";
let seq = 0;

interface Ctx {
  orgId: string;
  customerId: string;
}

async function mk(scheme: "KLEINUNTERNEHMER" | "REGULAR" = "KLEINUNTERNEHMER"): Promise<Ctx> {
  seq += 1;
  const tag = `KN${seq}`;
  const org = await dbInternal.organization.create({
    data: {
      legalName: `KU-Notify ${tag} GmbH`, addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin",
      vatId: `DE2229${String(seq).padStart(5, "0")}`, taxNumber: "22/229/00000", defaultTaxScheme: scheme,
    },
  });
  const orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  for (const year of [2228, 2229]) {
    await dbInternal.numberRange.upsert({
      where: { orgId_docType_year: { orgId, docType: "INVOICE", year } },
      create: { orgId, docType: "INVOICE", year, currentValue: 0, prefix: `${tag}R-`, pattern: "{PREFIX}{YYYY}-{SEQ}", seqPadding: 4, isActive: true },
      update: {},
    });
  }
  const customerId = (await dbInternal.customer.create({ data: { orgId, name: CUSTOMER_NAME, addressLine1: "Weg 1", postalCode: "10115", city: "Berlin", countryCode: "DE", type: "BUSINESS" } })).id;
  return { orgId, customerId };
}

async function setKuEnabled(orgId: string, on: boolean) {
  const enabledTypes = ALL_NOTIFICATION_TYPES.filter((t): t is NotificationType => on || t !== "KU_THRESHOLD");
  await saveNotificationSettings(orgId, { enabledTypes, emailDigest: false });
}

/** Kleinunternehmer-Rechnung (0 %, Netto = Brutto), festgeschrieben und voll bezahlt. */
async function paidInvoice(c: Ctx, netCents: number, now: Date = NOW) {
  const d = await createDraftInvoice(
    c.orgId,
    createInvoiceSchema.parse({
      customerId: c.customerId, type: "INVOICE", taxScheme: "KLEINUNTERNEHMER", currency: "EUR", issueDate: now, deliveryDate: now,
      notes: "Kleinunternehmer gemäß § 19 UStG, kein Ausweis von Umsatzsteuer",
      lines: [{ description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: netCents, taxRate: 0, taxCategory: "Z", discountPermille: 0, discountCents: 0 }],
    }),
    { now },
  );
  const inv = await finalizeInvoice(d.id, { now });
  await recordPayment(inv.id, { amountCents: netCents, paidAt: now, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId: c.orgId, now });
  return inv;
}

const kuNotes = (orgId: string) => dbInternal.notification.findMany({ where: { orgId, type: "KU_THRESHOLD" }, orderBy: { createdAt: "asc" } });

describe("checkKuNotifications", () => {
  it("eine Benachrichtigung je Stufe und Jahr; Stufenwechsel legt die naechste an", async () => {
    const c = await mk();
    await setKuEnabled(c.orgId, false); // Hooks aus, hier wird direkt geprueft
    await paidInvoice(c, 2_000_000); // 80 % von 25.000
    expect(await checkKuNotifications(c.orgId, NOW)).toBe(1);
    expect(await checkKuNotifications(c.orgId, NOW)).toBe(0);
    await paidInvoice(c, 600_000); // 26.000 -> Folgejahr verloren
    expect(await checkKuNotifications(c.orgId, NOW)).toBe(1);
    expect(await checkKuNotifications(c.orgId, NOW)).toBe(0);
    await paidInvoice(c, 8_000_000); // 106.000 -> ueberschritten
    expect(await checkKuNotifications(c.orgId, NOW)).toBe(1);
    expect(await checkKuNotifications(c.orgId, NOW)).toBe(0);
    const notes = await kuNotes(c.orgId);
    expect(notes.map((n) => n.dedupeKey)).toEqual(["ku-2229-warn", "ku-2229-next", "ku-2229-exceeded"]);
    expect(notes[2]!.title).toBe("Kleinunternehmerregelung: Umsatz 2229 über 100.000 € (§ 19 Abs. 1 UStG)");
  });

  it("Text enthaelt Paragraf, Hinweis und Betraege, aber keine Kundennamen", async () => {
    const c = await mk();
    await setKuEnabled(c.orgId, false);
    await paidInvoice(c, 2_100_000);
    await checkKuNotifications(c.orgId, NOW);
    const [n] = await kuNotes(c.orgId);
    expect(n!.title).toContain("§ 19");
    expect(n!.body!.endsWith(KU_NOTICE)).toBe(true);
    expect(n!.body).toContain("21.000,00");
    expect(n!.link).toBe("/");
    expect(`${n!.title} ${n!.body}`).not.toContain(CUSTOMER_NAME);
  });

  it("keine Meldung ohne Kleinunternehmerregelung oder unter der Warnschwelle", async () => {
    const reg = await mk("REGULAR");
    await setKuEnabled(reg.orgId, false);
    const d = await createDraftInvoice(
      reg.orgId,
      createInvoiceSchema.parse({
        customerId: reg.customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR", issueDate: NOW, deliveryDate: NOW,
        lines: [{ description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 3_000_000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
      }),
      { now: NOW },
    );
    const inv = await finalizeInvoice(d.id, { now: NOW });
    await recordPayment(inv.id, { amountCents: inv.grossTotalCents, paidAt: NOW, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId: reg.orgId, now: NOW });
    expect(await checkKuNotifications(reg.orgId, NOW)).toBe(0);

    const small = await mk();
    await setKuEnabled(small.orgId, false);
    await paidInvoice(small, 1_000_000);
    expect(await checkKuNotifications(small.orgId, NOW)).toBe(0);
    expect(await kuNotes(small.orgId)).toHaveLength(0);
  });
});

describe("Hooks und Job", () => {
  it("Festschreiben und Zahlung loesen die Pruefung ohne Job-Lauf aus", async () => {
    const c = await mk();
    await paidInvoice(c, 2_000_000);
    const notes = await kuNotes(c.orgId);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.dedupeKey).toBe("ku-2229-warn");
  });

  it("abgewaehlter Typ: weder Hook noch Job legen etwas an", async () => {
    const c = await mk();
    await setKuEnabled(c.orgId, false);
    await paidInvoice(c, 2_600_000);
    expect(await kuNotes(c.orgId)).toHaveLength(0);
    const res = await runNotificationsJob(NOW, { orgId: c.orgId });
    expect(res.byType.KU_THRESHOLD).toBeUndefined();
    expect(await kuNotes(c.orgId)).toHaveLength(0);
  });

  it("Job legt die Eintraege an und zaehlt sie in byType", async () => {
    const c = await mk();
    await setKuEnabled(c.orgId, false);
    await paidInvoice(c, 2_000_000);
    await setKuEnabled(c.orgId, true);
    const res = await runNotificationsJob(NOW, { orgId: c.orgId });
    expect(res.byType.KU_THRESHOLD).toBe(1);
    const again = await runNotificationsJob(NOW, { orgId: c.orgId });
    expect(again.byType.KU_THRESHOLD).toBeUndefined();
  });
});
