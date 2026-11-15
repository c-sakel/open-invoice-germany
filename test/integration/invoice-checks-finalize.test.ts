/**
 * Belegpruefungen beim Festschreiben: Hinweise (Ausstellfrist, Umsatzgrenze), Einfrieren des
 * Verzugshinweises fuer Verbraucher, Kennzeichnung im REST-Serializer. Testjahr 2230
 * (Invoice.number ist global eindeutig; jede Org bekommt ein eigenes Nummernpraefix).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { dbInternal, prisma, GobdImmutabilityError } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { updateDraftInvoice } from "@/domain/invoice/update";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { collectFinalizeWarnings } from "@/domain/invoice/finalize-warnings";
import { saveDocumentSettings } from "@/domain/document/settings";
import { saveMailSettings } from "@/domain/email/settings";
import { sendDocumentEmail } from "@/domain/email/send";
import { updateNumberRange } from "@/domain/numbering/ranges";
import { createRecurring } from "@/domain/recurring/create";
import { emitRecurringInvoice } from "../helpers/emit-recurring";
import { createMemoryProvider } from "@/lib/mail/memory";
import { serializeInvoice } from "@/api/serializers/invoice";
import { createInvoiceSchema, createRecurringSchema } from "@/schemas";

process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";

const NOW = new Date("2230-05-10T10:00:00.000Z");
let seq = 0;

interface Ctx {
  orgId: string;
  business: string;
  consumer: string;
  /** Geschaeftskunde in Oesterreich mit USt-IdNr. (ig. Lieferung). */
  eu: string;
}

async function mk(scheme: "REGULAR" | "KLEINUNTERNEHMER" = "REGULAR"): Promise<Ctx> {
  seq += 1;
  const tag = `PF${seq}`;
  const org = await dbInternal.organization.create({
    data: {
      legalName: `Pruefungen ${tag} GmbH`, addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin",
      vatId: `DE2230${String(seq).padStart(5, "0")}`, taxNumber: `22/230/0000${seq}`, defaultTaxScheme: scheme,
    },
  });
  await ensureOrgMasterdata(dbInternal, org.id);
  await updateNumberRange(org.id, "INVOICE", { pattern: "{PREFIX}{YYYY}-{SEQ:5}", prefix: `${tag}R-`, seqPadding: 5, yearlyReset: false, nextValue: 1 }, "system", NOW);
  await updateNumberRange(org.id, "CREDIT_NOTE", { pattern: "{PREFIX}{YYYY}-{SEQ:5}", prefix: `${tag}G-`, seqPadding: 5, yearlyReset: false, nextValue: 1 }, "system", NOW);
  const mkCustomer = async (name: string, type: "BUSINESS" | "CONSUMER") =>
    (await dbInternal.customer.create({
      data: { orgId: org.id, name, addressLine1: "Weg 1", postalCode: "10115", city: "Berlin", countryCode: "DE", type, email: "kunde@example.org" },
    })).id;
  const eu = (
    await dbInternal.customer.create({
      data: { orgId: org.id, name: "EU-Kunde", addressLine1: "Ring 1", postalCode: "1010", city: "Wien", countryCode: "AT", type: "BUSINESS", email: "eu@example.org", vatId: "ATU12345678" },
    })
  ).id;
  return { orgId: org.id, business: await mkCustomer("Geschaeftskunde", "BUSINESS"), consumer: await mkCustomer("Privatkunde", "CONSUMER"), eu };
}

interface DraftOpts {
  scheme?: "REGULAR" | "KLEINUNTERNEHMER" | "IG_LIEFERUNG";
  netCents?: number;
  delivery?: Date;
  issue?: Date;
  consumerDefaultNotice?: boolean | null;
}

function draftInput(customerId: string, o: DraftOpts = {}) {
  const scheme = o.scheme ?? "REGULAR";
  const zero = scheme !== "REGULAR";
  const notes = scheme === "KLEINUNTERNEHMER"
    ? "Kleinunternehmer gemäß § 19 UStG, kein Ausweis von Umsatzsteuer"
    : scheme === "IG_LIEFERUNG"
      ? "Steuerfreie innergemeinschaftliche Lieferung gemäß § 4 Nr. 1b i. V. m. § 6a UStG"
      : undefined;
  return createInvoiceSchema.parse({
    customerId, type: "INVOICE", taxScheme: scheme, currency: "EUR", issueDate: o.issue ?? NOW, deliveryDate: o.delivery ?? NOW,
    ...(notes ? { notes } : {}),
    ...(o.consumerDefaultNotice !== undefined ? { consumerDefaultNotice: o.consumerDefaultNotice } : {}),
    lines: [{ description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: o.netCents ?? 10000, taxRate: zero ? 0 : 19, taxCategory: scheme === "KLEINUNTERNEHMER" ? "Z" : scheme === "IG_LIEFERUNG" ? "K" : "S", discountPermille: 0, discountCents: 0 }],
  });
}

async function draft(c: Ctx, customerId: string, o: DraftOpts = {}) {
  return createDraftInvoice(c.orgId, draftInput(customerId, o), { now: NOW });
}

async function fin(c: Ctx, customerId: string, o: DraftOpts = {}) {
  const d = await draft(c, customerId, o);
  await finalizeInvoice(d.id, { now: NOW });
  return dbInternal.invoice.findUniqueOrThrow({ where: { id: d.id } });
}

describe("Hinweis Ausstellfrist (§ 14a UStG)", () => {
  let c: Ctx;
  beforeAll(async () => {
    c = await mk();
  });

  it("nach Fristablauf: Hinweis, Festschreiben gelingt", async () => {
    // Lieferung 03.03., Frist 15.04., Belegdatum 10.05.
    const d = await draft(c, c.eu, { scheme: "IG_LIEFERUNG", delivery: new Date("2230-03-03T10:00:00.000Z") });
    const w = await collectFinalizeWarnings(c.orgId, d.id, { now: NOW });
    expect(w.map((x) => x.code)).toContain("ausstellfrist");
    const done = await finalizeInvoice(d.id, { now: NOW });
    expect(done.status).toBe("FINALIZED");
  });

  it("innerhalb der Frist: kein Hinweis", async () => {
    const d = await draft(c, c.eu, { scheme: "IG_LIEFERUNG", delivery: new Date("2230-04-20T10:00:00.000Z") });
    const w = await collectFinalizeWarnings(c.orgId, d.id, { now: NOW });
    expect(w.map((x) => x.code)).not.toContain("ausstellfrist");
  });

  it("andere Steuerschemata: kein Hinweis", async () => {
    const d = await draft(c, c.business, { delivery: new Date("2230-01-03T10:00:00.000Z") });
    const w = await collectFinalizeWarnings(c.orgId, d.id, { now: NOW });
    expect(w.map((x) => x.code)).not.toContain("ausstellfrist");
  });
});

describe("Hinweis Umsatzgrenze Kleinunternehmerregelung", () => {
  it("ueber der Grenze: Hinweis, Beleg bleibt Kleinunternehmer-Beleg", async () => {
    const c = await mk("KLEINUNTERNEHMER");
    await fin(c, c.business, { scheme: "KLEINUNTERNEHMER", netCents: 10_100_000 });
    const d = await draft(c, c.business, { scheme: "KLEINUNTERNEHMER", netCents: 5_000 });
    const w = await collectFinalizeWarnings(c.orgId, d.id, { now: NOW });
    const ku = w.find((x) => x.code === "ku-grenze");
    expect(ku?.message).toContain("§ 19 Abs. 1 UStG");
    const done = await finalizeInvoice(d.id, { now: NOW });
    expect(done.taxScheme).toBe("KLEINUNTERNEHMER");
    expect(done.status).toBe("FINALIZED");
  });

  it("unter der Grenze und bei anderem Schema: kein Hinweis", async () => {
    const c = await mk("KLEINUNTERNEHMER");
    const d = await draft(c, c.business, { scheme: "KLEINUNTERNEHMER", netCents: 5_000 });
    expect((await collectFinalizeWarnings(c.orgId, d.id, { now: NOW })).map((x) => x.code)).not.toContain("ku-grenze");
    const r = await draft(c, c.business, { scheme: "REGULAR", netCents: 20_000_000 });
    expect((await collectFinalizeWarnings(c.orgId, r.id, { now: NOW })).map((x) => x.code)).not.toContain("ku-grenze");
  });

  it("Entwurf, der die Grenze erst selbst ueberschreitet: Hinweis", async () => {
    const c = await mk("KLEINUNTERNEHMER");
    await fin(c, c.business, { scheme: "KLEINUNTERNEHMER", netCents: 9_900_000 });
    const d = await draft(c, c.business, { scheme: "KLEINUNTERNEHMER", netCents: 200_000 });
    expect((await collectFinalizeWarnings(c.orgId, d.id, { now: NOW })).map((x) => x.code)).toContain("ku-grenze");
  });
});

describe("Verzugshinweis beim Festschreiben einfrieren", () => {
  let c: Ctx;
  beforeAll(async () => {
    c = await mk();
  });

  it("Verbraucher und Einstellung an: eingefroren true", async () => {
    await saveDocumentSettings(c.orgId, { consumerDefaultNotice: true });
    const inv = await fin(c, c.consumer);
    expect(inv.consumerDefaultNotice).toBe(true);
  });

  it("Einstellung aus: false", async () => {
    await saveDocumentSettings(c.orgId, { consumerDefaultNotice: false });
    const inv = await fin(c, c.consumer);
    expect(inv.consumerDefaultNotice).toBe(false);
  });

  it("Vorgabe false am Entwurf trotz Einstellung: false", async () => {
    await saveDocumentSettings(c.orgId, { consumerDefaultNotice: true });
    const inv = await fin(c, c.consumer, { consumerDefaultNotice: false });
    expect(inv.consumerDefaultNotice).toBe(false);
  });

  it("Geschaeftskunde: automatisch false, Vorgabe true gilt", async () => {
    await saveDocumentSettings(c.orgId, { consumerDefaultNotice: true });
    expect((await fin(c, c.business)).consumerDefaultNotice).toBe(false);
    expect((await fin(c, c.business, { consumerDefaultNotice: true })).consumerDefaultNotice).toBe(true);
  });

  it("Vorgabe laesst sich am Entwurf aendern und zuruecksetzen", async () => {
    await saveDocumentSettings(c.orgId, { consumerDefaultNotice: true });
    const d = await draft(c, c.consumer, { consumerDefaultNotice: false });
    expect(d.consumerDefaultNotice).toBe(false);
    const u = await updateDraftInvoice(c.orgId, d.id, { consumerDefaultNotice: null }, "test");
    expect(u.consumerDefaultNotice).toBeNull();
    await finalizeInvoice(d.id, { now: NOW });
    expect((await dbInternal.invoice.findUniqueOrThrow({ where: { id: d.id } })).consumerDefaultNotice).toBe(true);
  });

  it("Storno der Rechnung: Gutschrift false", async () => {
    await saveDocumentSettings(c.orgId, { consumerDefaultNotice: true });
    const inv = await fin(c, c.consumer);
    expect(inv.consumerDefaultNotice).toBe(true);
    const res = await cancelInvoice(inv.id, { orgId: c.orgId, now: NOW });
    const credit = await dbInternal.invoice.findUniqueOrThrow({ where: { id: res.creditNote.id } });
    expect(credit.type).toBe("CREDIT_NOTE");
    expect(credit.consumerDefaultNotice).toBe(false);
  });

  it("Auto-Festschreiben beim Versand friert ebenso ein", async () => {
    await saveDocumentSettings(c.orgId, { consumerDefaultNotice: true, autoFinalizeOnSend: true });
    await saveMailSettings(c.orgId, {
      host: "localhost", port: 2525, security: "NONE", fromName: "Pruefungen GmbH", fromEmail: "rechnung@example.org",
      defaultCc: "", defaultBcc: "", copyToSelf: false,
    });
    const d = await draft(c, c.consumer);
    const r = await sendDocumentEmail(
      c.orgId, "tester",
      { docType: "INVOICE", docId: d.id, to: "kunde@example.org", cc: "", bcc: "", subject: "Ihre Rechnung", body: "Hallo", standardAttachments: [] },
      [], createMemoryProvider(),
    );
    expect(r.status).toBe("SENT");
    const after = await dbInternal.invoice.findUniqueOrThrow({ where: { id: d.id } });
    expect(after.status).not.toBe("DRAFT");
    expect(after.consumerDefaultNotice).toBe(true);
  });

  it("Abo-Lauf friert ebenso ein", async () => {
    await saveDocumentSettings(c.orgId, { consumerDefaultNotice: true });
    const rec = await createRecurring(
      c.orgId,
      createRecurringSchema.parse({
        customerId: c.consumer, title: "Abo", startDate: NOW, autoFinalize: true,
        lines: [{ lineType: "ITEM", description: "Wartung", quantityMilli: 1000, unitNetPriceCents: 5000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
      }),
    );
    const emitted = await emitRecurringInvoice(rec.id, { now: NOW });
    const inv = await dbInternal.invoice.findUniqueOrThrow({ where: { id: emitted.invoiceId } });
    expect(inv.status).not.toBe("DRAFT");
    expect(inv.consumerDefaultNotice).toBe(true);
  });

  it("festgeschriebener Beleg ist gesperrt, Umschalten der Einstellung aendert nichts", async () => {
    await saveDocumentSettings(c.orgId, { consumerDefaultNotice: true });
    const inv = await fin(c, c.consumer);
    await expect(prisma.invoice.update({ where: { id: inv.id }, data: { consumerDefaultNotice: false } })).rejects.toBeInstanceOf(GobdImmutabilityError);
    await saveDocumentSettings(c.orgId, { consumerDefaultNotice: false });
    expect((await dbInternal.invoice.findUniqueOrThrow({ where: { id: inv.id } })).consumerDefaultNotice).toBe(true);
  });
});

describe("Serializer", () => {
  it("liefert smallAmount, issueDeadline und consumerDefaultNotice", async () => {
    const c = await mk();
    await saveDocumentSettings(c.orgId, { consumerDefaultNotice: true });
    const inv = await fin(c, c.consumer, { netCents: 10_000 }); // brutto 119,00
    const out = serializeInvoice(inv, new Set());
    expect(out.smallAmount).toBe(true);
    expect(out.issueDeadline).toBeNull();
    expect(out.consumerDefaultNotice).toBe(true);

    const big = await fin(c, c.business, { netCents: 50_000 });
    expect(serializeInvoice(big, new Set()).smallAmount).toBe(false);

    const ig = await draft(c, c.eu, { scheme: "IG_LIEFERUNG", delivery: new Date("2230-03-03T10:00:00.000Z") });
    const igOut = serializeInvoice(ig, new Set());
    expect(igOut.issueDeadline).toBe("2230-04-15");
    expect(igOut.smallAmount).toBe(false);
    expect(igOut.consumerDefaultNotice).toBeNull();
  });

  it("Bestandsbeleg mit NULL (festgeschrieben) liefert false", async () => {
    const c = await mk();
    const base = await draft(c, c.consumer);
    await dbInternal.invoice.update({ where: { id: base.id }, data: { status: "FINALIZED", number: `PFALT-${seq}`, consumerDefaultNotice: null } });
    const row = await dbInternal.invoice.findUniqueOrThrow({ where: { id: base.id } });
    expect(row.consumerDefaultNotice).toBeNull();
    expect(serializeInvoice(row, new Set()).consumerDefaultNotice).toBe(false);
  });
});
