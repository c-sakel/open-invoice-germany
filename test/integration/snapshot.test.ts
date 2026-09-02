/**
 * Phase 0 — Beleg-Snapshots: Belege belegen, dass eine Stammdatenaenderung
 * (Kunde/Organisation) festgeschriebene Belege nicht mehr veraendert, ein
 * Entwurf aber weiterhin live spiegelt.
 *
 * Aufbau angelehnt an test/integration/gobd.test.ts (gleiche Helfer-Semantik
 * fuer Organisation/Kunde/Rechnung, da dort keine exportierten Helfer existieren).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { dbInternal } from "@/lib/db";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { createBusinessDocument } from "@/domain/document/create";
import { loadEInvoiceData } from "@/lib/einvoice/load";
import { buildEInvoiceData } from "@/lib/einvoice/mapper";
import { buyerSnapshotSchema, sellerSnapshotSchema, createDocumentSchema, type CreateInvoiceInput } from "@/schemas";

// Eigenes Jahr fuer die Nummernvergabe: "Invoice.number" ist global @unique
// (nicht pro Organisation), und test.db wird ueber die gesamte Testlaufzeit
// geteilt (gobd.test.ts nutzt 2026 mit derselben Sequenz-Startzahl).
const FIX_DATE = new Date("2027-06-09T10:00:00.000Z");

async function setup() {
  const org = await dbInternal.organization.create({
    data: {
      legalName: "Test GmbH",
      addressLine1: "Hauptstr. 1",
      postalCode: "21339",
      city: "Lüneburg",
      vatId: "DE123456789",
      taxNumber: "33/123/45678",
    },
  });
  const customer = await dbInternal.customer.create({
    data: { orgId: org.id, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  });
  return { orgId: org.id, customerId: customer.id };
}

const line = { description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19 as const, taxCategory: "S" as const, discountPermille: 0 };

function baseInput(customerId: string, extra: Partial<CreateInvoiceInput> = {}): CreateInvoiceInput {
  return {
    customerId,
    type: "INVOICE",
    taxScheme: "REGULAR",
    currency: "EUR",
    deliveryDate: new Date("2026-06-01"),
    lines: [line],
    ...extra,
  } as CreateInvoiceInput;
}

describe("Phase 0 — Snapshots", () => {
  let orgId = "";
  let customerId = "";
  beforeAll(async () => {
    ({ orgId, customerId } = await setup());
  });

  it("festgeschriebene Rechnung behaelt alte Kunden- und Firmendaten", async () => {
    const inv = await createDraftInvoice(orgId, baseInput(customerId));
    await finalizeInvoice(inv.id, { now: FIX_DATE });
    await dbInternal.customer.update({ where: { id: customerId }, data: { name: "GEAENDERT AG", city: "Neustadt" } });
    await dbInternal.organization.update({ where: { id: orgId }, data: { legalName: "GEAENDERT GmbH" } });
    const loaded = await loadEInvoiceData(inv.id);
    expect(loaded!.data.buyer.name).not.toBe("GEAENDERT AG");
    expect(loaded!.data.buyer.city).not.toBe("Neustadt");
    expect(loaded!.data.seller.name).not.toBe("GEAENDERT GmbH");
    expect(loaded!.invoice.snapshotSource).toBe("FINALIZE");
  });

  it("Entwurf spiegelt Stammdatenaenderung weiterhin live", async () => {
    const inv = await createDraftInvoice(orgId, baseInput(customerId));
    const loaded = await loadEInvoiceData(inv.id);
    expect(loaded!.data.buyer.name).toBe("GEAENDERT AG");
    expect(loaded!.invoice.snapshotSource).toBeNull();
  });

  it("Ausgabegleichheit: Snapshot-Pfad und Live-Pfad liefern dasselbe EInvoiceData", async () => {
    const inv = await createDraftInvoice(orgId, baseInput(customerId));
    const fin = await finalizeInvoice(inv.id, { now: FIX_DATE });
    const withSnapshot = buildEInvoiceData(fin);
    const live = buildEInvoiceData({ ...fin, sellerSnapshotJson: null, buyerSnapshotJson: null });
    expect(withSnapshot).toEqual(live);
  });

  it("Storno-Gutschrift traegt eigenen Snapshot", async () => {
    const inv = await createDraftInvoice(orgId, baseInput(customerId));
    await finalizeInvoice(inv.id, { now: FIX_DATE });
    const { creditNote } = await cancelInvoice(inv.id, { now: FIX_DATE });
    const credit = await dbInternal.invoice.findUniqueOrThrow({ where: { id: creditNote.id } });
    expect(credit.snapshotSource).toBe("FINALIZE");
    expect(buyerSnapshotSchema.safeParse(JSON.parse(credit.buyerSnapshotJson!)).success).toBe(true);
  });

  it("Geschaeftsdokument bekommt Snapshot bei Erstellung", async () => {
    const q = await createBusinessDocument(
      orgId,
      createDocumentSchema.parse({ kind: "ANGEBOT", customerId, lines: [line] }),
    );
    expect(q.snapshotSource).toBe("CREATE");
    expect(sellerSnapshotSchema.safeParse(JSON.parse(q.sellerSnapshotJson!)).success).toBe(true);
  });

  it("Backfill-Migration friert Belege ohne Snapshot mit Herkunft MIGRATION ein", async () => {
    const inv = await createDraftInvoice(orgId, baseInput(customerId));
    await finalizeInvoice(inv.id, { now: FIX_DATE });
    await dbInternal.$executeRawUnsafe(
      `UPDATE "Invoice" SET "sellerSnapshotJson" = NULL, "buyerSnapshotJson" = NULL, "snapshotSource" = NULL, "snapshotAt" = NULL WHERE "id" = '${inv.id}'`,
    );
    const dir = readdirSync("prisma/migrations").find((d) => d.endsWith("_phase0_backfill_snapshots"))!;
    const sql = readFileSync(join("prisma/migrations", dir, "migration.sql"), "utf8");
    // Kommentarzeilen VOR dem Split entfernen: der Kopfkommentar enthaelt selbst ein
    // Semikolon ("Nur Belege ohne Snapshot; Entwuerfe bleiben live."), das einen
    // naiven split(";") mitten im Kommentar zerteilen wuerde.
    const withoutComments = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    for (const stmt of withoutComments.split(";").map((s) => s.trim()).filter(Boolean)) {
      await dbInternal.$executeRawUnsafe(stmt);
    }
    const after = await dbInternal.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after.snapshotSource).toBe("MIGRATION");
    const parsed = buyerSnapshotSchema.safeParse(JSON.parse(after.buyerSnapshotJson!));
    expect(parsed.success).toBe(true);
    const live = await dbInternal.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect(parsed.data!.name).toBe(live.name);
  });
});
