/**
 * Einfrierpunkt Angebot, AB, Lieferschein (Phase 16g, Task 7, R7). Eigenes Jahr 2121.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { dbInternal, prisma, FrozenPrintOptionsError } from "@/lib/db";
import { createBusinessDocument } from "@/domain/document/create";
import { createDeliveryNote } from "@/domain/delivery-note/create";
import { duplicateDocument } from "@/domain/document/duplicate";
import { setQuoteStatus, setDeliveryNoteStatus } from "@/domain/document/status";
import { createShareLink, resolveShareToken } from "@/domain/quote-share/link";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { saveBrandingSettings } from "@/domain/settings/branding";
import { savePrintSettings, setPrintOptions } from "@/domain/settings/print";
import { loadPdfTheme } from "@/domain/settings/theme";
import { saveLayoutDesign } from "@/domain/layout-design/save";
import { InvalidOperationError } from "@/domain/errors";
import { presetConfig } from "@/lib/pdf/layouts/presets";
import { GET as publicPdf } from "@/app/api/public/angebot/[token]/pdf/route";

const NOW = new Date("2121-03-01T10:00:00.000Z");
let orgId: string;
let customerId: string;
let designId: string;
let v1Id: string;

const line = { description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19 as const, taxCategory: "S" as const, discountPermille: 0 };
const withPrimary = (base: ReturnType<typeof presetConfig>, primary: string) => ({ ...base, colors: { ...base.colors, primary } });
const makeDoc = (kind: "ANGEBOT" | "AUFTRAGSBESTAETIGUNG" | "PROFORMA" = "ANGEBOT") =>
  createBusinessDocument(orgId, { kind, customerId, taxScheme: "REGULAR", currency: "EUR", lines: [line] }, { now: NOW });
const frozenVersion = (json: string | null): string | undefined => (json ? (JSON.parse(json) as { layoutVersionId?: string }).layoutVersionId : undefined);
async function newVersion(color: string): Promise<string> {
  const cur = await dbInternal.layoutDesign.findUniqueOrThrow({ where: { id: designId }, select: { currentVersion: true } });
  const base = (await dbInternal.layoutDesignVersion.findFirstOrThrow({ where: { designId, version: cur.currentVersion }, select: { configJson: true } })).configJson;
  const saved = await saveLayoutDesign(orgId, { id: designId, name: "Freeze", config: withPrimary(JSON.parse(base), color) }, "tester", NOW);
  return (await dbInternal.layoutDesignVersion.findFirstOrThrow({ where: { designId, version: saved.currentVersion }, select: { id: true } })).id;
}

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  orgId = (await dbInternal.organization.create({ data: { legalName: "Freeze GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" } })).id;
  customerId = (await dbInternal.customer.create({ data: { orgId, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" } })).id;
  await ensureOrgMasterdata(dbInternal, orgId);
  const d = await saveLayoutDesign(orgId, { name: "Freeze", baseLayoutId: "standard" }, "tester", NOW);
  designId = d.id;
  v1Id = (await dbInternal.layoutDesignVersion.findFirstOrThrow({ where: { designId, version: 1 }, select: { id: true } })).id;
  await saveBrandingSettings(orgId, { layoutByType: { QUOTE: d.ref, ORDER_CONFIRMATION: d.ref, DELIVERY_NOTE: d.ref } });
});

describe("Angebot", () => {
  it("Entwurf folgt der aktuellen Version, SENT friert ein, spaetere Version aendert nichts (auch oeffentlicher Link)", async () => {
    const q = await makeDoc();
    expect((await loadPdfTheme(orgId, q.printOptionsJson, "QUOTE")).layoutVersionId).toBe(v1Id);
    const v2 = await newVersion("#aa0000");
    expect((await loadPdfTheme(orgId, q.printOptionsJson, "QUOTE")).layoutVersionId).toBe(v2);
    expect(q.printOptionsJson).toBeNull();

    const link = await createShareLink(orgId, q.id, {}, { now: NOW });
    const sent = await setQuoteStatus(orgId, q.id, "SENT", { now: NOW });
    expect(frozenVersion(sent.printOptionsJson)).toBe(v2);
    await newVersion("#00aa00");
    const stored = await dbInternal.quote.findUniqueOrThrow({ where: { id: q.id }, select: { printOptionsJson: true } });
    expect((await loadPdfTheme(orgId, stored.printOptionsJson, "QUOTE")).layoutVersionId).toBe(v2);

    const resolved = await resolveShareToken(link.token, NOW);
    expect(frozenVersion(resolved?.quote.printOptionsJson ?? null)).toBe(v2);
    const res = await publicPdf(new Request("http://localhost/x"), { params: Promise.resolve({ token: link.token }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
  });

  it("AB und Proforma frieren beim ersten Wechsel aus DRAFT ein", async () => {
    const ab = await makeDoc("AUFTRAGSBESTAETIGUNG");
    const cur = await dbInternal.layoutDesign.findUniqueOrThrow({ where: { id: designId }, select: { currentVersion: true } });
    const curId = (await dbInternal.layoutDesignVersion.findFirstOrThrow({ where: { designId, version: cur.currentVersion }, select: { id: true } })).id;
    const sent = await setQuoteStatus(orgId, ab.id, "SENT", { now: NOW });
    expect(frozenVersion(sent.printOptionsJson)).toBe(curId);
    const pf = await makeDoc("PROFORMA");
    const pfSent = await setQuoteStatus(orgId, pf.id, "SENT", { now: NOW });
    expect(JSON.parse(pfSent.printOptionsJson ?? "{}").layoutId).toBe("standard");
  });

  it("festes Layout: nach SENT globale USt-Spalte aus -> Beleg behaelt den eingefrorenen Schalter", async () => {
    await saveBrandingSettings(orgId, { layoutByType: { QUOTE: "klassik" } });
    const q = await makeDoc();
    const sent = await setQuoteStatus(orgId, q.id, "SENT", { now: NOW });
    expect(JSON.parse(sent.printOptionsJson ?? "{}").showTaxRatePerLine).toBe(true);
    await savePrintSettings(orgId, { showTaxRatePerLine: false });
    const stored = await dbInternal.quote.findUniqueOrThrow({ where: { id: q.id }, select: { printOptionsJson: true } });
    expect((await loadPdfTheme(orgId, stored.printOptionsJson, "QUOTE")).options.showTaxRatePerLine).toBe(true);
    await savePrintSettings(orgId, { showTaxRatePerLine: true });
  });

  it("Bestand: SENT ohne eingefrorenes JSON rendert mit aktueller Aufloesung, ohne nachtraegliches Einfrieren", async () => {
    const q = await makeDoc();
    await dbInternal.quote.update({ where: { id: q.id }, data: { status: "SENT" } });
    const theme = await loadPdfTheme(orgId, null, "QUOTE");
    expect(theme.layoutId).toBe("klassik");
    expect((await dbInternal.quote.findUniqueOrThrow({ where: { id: q.id }, select: { printOptionsJson: true } })).printOptionsJson).toBeNull();
  });
});

describe("Lieferschein", () => {
  it("direkt als CREATED angelegt: eingefroren", async () => {
    await saveBrandingSettings(orgId, { layoutByType: { DELIVERY_NOTE: `design:${designId}` } });
    const dn = await createDeliveryNote(orgId, { customerId, lines: [{ description: "Ware", quantityMilli: 1000, unitNetPriceCents: 0, taxRate: 19 }] }, { now: NOW });
    expect(dn.status).toBe("CREATED");
    const cur = await dbInternal.layoutDesign.findUniqueOrThrow({ where: { id: designId }, select: { currentVersion: true } });
    const curId = (await dbInternal.layoutDesignVersion.findFirstOrThrow({ where: { designId, version: cur.currentVersion }, select: { id: true } })).id;
    expect(frozenVersion(dn.printOptionsJson)).toBe(curId);
    await newVersion("#0000aa");
    const stored = await dbInternal.deliveryNote.findUniqueOrThrow({ where: { id: dn.id }, select: { printOptionsJson: true } });
    expect((await loadPdfTheme(orgId, stored.printOptionsJson, "DELIVERY_NOTE")).layoutVersionId).toBe(curId);
  });

  it("Duplikat DRAFT -> CREATED: Nummer und Einfrieren", async () => {
    const src = await createDeliveryNote(orgId, { customerId, lines: [{ description: "Ware", quantityMilli: 1000, unitNetPriceCents: 0, taxRate: 19 }] }, { now: NOW });
    const copy = await duplicateDocument(orgId, "DELIVERY_NOTE", src.id, "tester", NOW);
    const draft = await dbInternal.deliveryNote.findUniqueOrThrow({ where: { id: copy.id }, select: { printOptionsJson: true, number: true, status: true } });
    expect(draft.status).toBe("DRAFT");
    expect(draft.printOptionsJson).toBeNull();
    const created = await setDeliveryNoteStatus(orgId, copy.id, "CREATED", { now: NOW });
    expect(created.number).toBeTruthy();
    const cur = await dbInternal.layoutDesign.findUniqueOrThrow({ where: { id: designId }, select: { currentVersion: true } });
    const curId = (await dbInternal.layoutDesignVersion.findFirstOrThrow({ where: { designId, version: cur.currentVersion }, select: { id: true } })).id;
    expect(frozenVersion(created.printOptionsJson)).toBe(curId);
  });
});

describe("Guard printOptionsJson", () => {
  it("Angebot SENT: update scheitert, DRAFT ok, archivedAt ok, setPrintOptions bleibt InvalidOperationError", async () => {
    const q = await makeDoc();
    await expect(prisma.quote.update({ where: { id: q.id }, data: { printOptionsJson: "{}" } })).resolves.toBeDefined();
    await setQuoteStatus(orgId, q.id, "SENT", { now: NOW });
    await expect(prisma.quote.update({ where: { id: q.id }, data: { printOptionsJson: "{}" } })).rejects.toBeInstanceOf(FrozenPrintOptionsError);
    await expect(prisma.quote.updateMany({ where: { id: q.id }, data: { printOptionsJson: "{}" } })).rejects.toBeInstanceOf(FrozenPrintOptionsError);
    await expect(
      prisma.quote.upsert({ where: { id: q.id }, create: { orgId, customerId, kind: "ANGEBOT" }, update: { printOptionsJson: "{}" } }),
    ).rejects.toBeInstanceOf(FrozenPrintOptionsError);
    await expect(prisma.quote.update({ where: { id: q.id }, data: { archivedAt: NOW } })).resolves.toBeDefined();
    await expect(setPrintOptions(orgId, { kind: "QUOTE", id: q.id }, {})).rejects.toBeInstanceOf(InvalidOperationError);
  });

  it("Lieferschein CREATED: updateMany mit printOptionsJson scheitert, andere Felder nicht", async () => {
    const dn = await createDeliveryNote(orgId, { customerId, lines: [{ description: "Ware", quantityMilli: 1000, unitNetPriceCents: 0, taxRate: 19 }] }, { now: NOW });
    await expect(prisma.deliveryNote.updateMany({ where: { id: dn.id }, data: { printOptionsJson: "{}" } })).rejects.toBeInstanceOf(FrozenPrintOptionsError);
    await expect(prisma.deliveryNote.update({ where: { id: dn.id }, data: { archivedAt: NOW } })).resolves.toBeDefined();
  });
});
