/**
 * Layout-Designs (Phase 16g, Task 6): speichern, zuordnen, einfrieren. Eigenes Jahr 2120
 * (Invoice.number ist global @unique); ARCHIVE_DIR zeigt auf ein temporaeres Verzeichnis.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ZodError } from "zod";
import { dbInternal } from "@/lib/db";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { ensureInvoiceArchive } from "@/domain/invoice/archive";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDunning } from "@/domain/dunning/create";
import { ensureDunningArchive } from "@/domain/dunning/archive";
import { saveBrandingSettings } from "@/domain/settings/branding";
import { setPrintOptions } from "@/domain/settings/print";
import { loadPdfTheme } from "@/domain/settings/theme";
import { archiveLayoutDesign, saveLayoutDesign, DESIGN_CONFLICT } from "@/domain/layout-design/save";
import { getLayoutDesign, listLayoutDesignVersions, listLayoutDesigns } from "@/domain/layout-design/list";
import { resolveLayoutSelection } from "@/domain/layout-design/resolve";
import { InvalidOperationError, ValidationError } from "@/domain/errors";
import { configHash } from "@/lib/pdf/layouts/config-hash";
import { presetConfig } from "@/lib/pdf/layouts/presets";
import { loadEInvoiceData } from "@/lib/einvoice/load";
import { buildFacturXCII } from "@/lib/einvoice/cii";
import { renderZugferdPdf } from "@/lib/einvoice/zugferd";
import { renderDunningPdf } from "@/lib/pdf/dunning-pdf";
import { buildDunningPdfData } from "@/lib/pdf/dunning-data";
import { readArchiveFile } from "@/lib/archive/storage";
import { normalizedPdfHash } from "../helpers/pdf-normalize";
import type { CreateInvoiceInput } from "@/schemas";

import * as configurable from "@/lib/pdf/layouts/configurable";

const ISSUE = new Date("2120-03-01T10:00:00.000Z");
const DUNNING_AT = new Date("2120-04-20T10:00:00.000Z");
let orgId: string;
let otherOrgId: string;
let customerId: string;
let tmpDir: string;
let prevEnv: string | undefined;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oig-layout-design-"));
  prevEnv = process.env.ARCHIVE_DIR;
  process.env.ARCHIVE_DIR = tmpDir;
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  orgId = (await dbInternal.organization.create({ data: { legalName: "Design GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" } })).id;
  otherOrgId = (await dbInternal.organization.create({ data: { legalName: "Fremd GmbH", addressLine1: "Weg 3", postalCode: "21339", city: "Lüneburg", vatId: "DE987654321", taxNumber: "33/123/99999" } })).id;
  customerId = (await dbInternal.customer.create({ data: { orgId, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" } })).id;
  await ensureOrgMasterdata(dbInternal, orgId);
});

afterAll(async () => {
  if (prevEnv === undefined) delete process.env.ARCHIVE_DIR;
  else process.env.ARCHIVE_DIR = prevEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function invoiceInput(): CreateInvoiceInput {
  return {
    customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR",
    documentDiscountPermille: 0, documentDiscountCents: 0, documentChargePermille: 0, documentChargeCents: 0,
    issueDate: ISSUE, deliveryDate: new Date("2120-02-25"), dueDate: new Date("2120-03-15"),
    lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
  } as CreateInvoiceInput;
}
const withPrimary = (base: ReturnType<typeof presetConfig>, primary: string) => ({ ...base, colors: { ...base.colors, primary } });
async function assign(types: Record<string, string>) {
  await saveBrandingSettings(orgId, { layoutByType: types });
}

describe("Designs speichern", () => {
  it("neu ohne Konfiguration: Version 1 aus der Startvorlage, ActivityLog", async () => {
    const d = await saveLayoutDesign(orgId, { name: "Klassisch", baseLayoutId: "klassik" }, "tester", ISSUE);
    expect(d.currentVersion).toBe(1);
    expect(d.configHash).toBe(configHash(presetConfig("klassik")));
    expect(d.ref).toBe(`design:${d.id}`);
    const log = await dbInternal.activityLog.findMany({ where: { orgId, entityType: "LAYOUT_DESIGN", entityId: d.id, type: "LAYOUT_DESIGN_SAVED" } });
    expect(log).toHaveLength(1);
  });

  it("neue Farbe = Version 2; gleiche Konfiguration bleibt, Umbenennen erzeugt keine Version", async () => {
    const d = await saveLayoutDesign(orgId, { name: "Versionen", baseLayoutId: "standard" }, "tester");
    const cfg = withPrimary(d.config, "#aa0000");
    const v2 = await saveLayoutDesign(orgId, { id: d.id, name: "Versionen", config: cfg }, "tester");
    expect(v2.currentVersion).toBe(2);
    expect((await saveLayoutDesign(orgId, { id: d.id, name: "Versionen", config: cfg }, "tester")).currentVersion).toBe(2);
    const renamed = await saveLayoutDesign(orgId, { id: d.id, name: "Versionen neu" }, "tester");
    expect(renamed.currentVersion).toBe(2);
    expect(renamed.name).toBe("Versionen neu");
    expect((await listLayoutDesignVersions(orgId, d.id)).map((v) => v.version)).toEqual([1, 2]);
    expect((await getLayoutDesign(orgId, d.id)).config.colors.primary).toBe("#aa0000");
    expect((await listLayoutDesigns(orgId)).some((x) => x.id === d.id)).toBe(true);
  });

  it("doppelter Name in der Organisation und ungueltige Konfiguration werden abgelehnt", async () => {
    await saveLayoutDesign(orgId, { name: "Doppelt" }, "tester");
    await expect(saveLayoutDesign(orgId, { name: "Doppelt" }, "tester")).rejects.toThrow(new InvalidOperationError("Ein Design mit diesem Namen existiert bereits."));
    const base = presetConfig("standard");
    await expect(saveLayoutDesign(orgId, { name: "Kaputt", config: { ...base, colors: { ...base.colors, primary: "rot" } } }, "tester")).rejects.toBeInstanceOf(ZodError);
  });

  // Verdrahtungstest: fuer schema-gueltige Konfigurationen liefert checkRecipientWindow null (siehe
  // din5008-window.test.ts); hier wird nur geprueft, dass ein Fehlertext das Speichern verhindert.
  it("Verdrahtung: meldet checkRecipientWindow einen Fehlertext, wird weder angelegt noch eine Version gespeichert", async () => {
    const d = await saveLayoutDesign(orgId, { name: "Fenster" }, "tester");
    const spy = vi.spyOn(configurable, "checkRecipientWindow").mockReturnValue("Anschrift passt nicht ins Fenster.");
    try {
      await expect(saveLayoutDesign(orgId, { id: d.id, name: "Fenster neu" }, "tester")).resolves.toBeDefined(); // reines Umbenennen prueft nicht erneut
      await expect(saveLayoutDesign(orgId, { id: d.id, name: "Fenster neu", config: withPrimary(d.config, "#00aa00") }, "tester")).rejects.toBeInstanceOf(ValidationError);
      await expect(saveLayoutDesign(orgId, { name: "Fenster 2" }, "tester")).rejects.toThrow("Anschrift passt nicht ins Fenster.");
    } finally {
      spy.mockRestore();
    }
    expect((await getLayoutDesign(orgId, d.id)).currentVersion).toBe(1);
    expect(await dbInternal.layoutDesign.count({ where: { orgId, name: "Fenster 2" } })).toBe(0);
  });

  it("gleichzeitige Speicherungen: Versionen bleiben lueckenlos, Verlierer melden den Konflikt statt eines Namensfehlers", async () => {
    const d = await saveLayoutDesign(orgId, { name: "Rennen" }, "tester");
    const results = await Promise.allSettled([
      saveLayoutDesign(orgId, { id: d.id, name: "Rennen", config: withPrimary(d.config, "#110000") }, "tester"),
      saveLayoutDesign(orgId, { id: d.id, name: "Rennen", config: withPrimary(d.config, "#220000") }, "tester"),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    for (const r of results) {
      if (r.status === "rejected") expect(String((r.reason as Error).message)).toBe(DESIGN_CONFLICT);
    }
    const versions = (await listLayoutDesignVersions(orgId, d.id)).map((v) => v.version);
    expect(versions).toEqual(versions.map((_, i) => i + 1));
    expect((await getLayoutDesign(orgId, d.id)).currentVersion).toBe(versions.length);
  });
});

describe("Zuordnung im Branding", () => {
  it("layoutByType.INVOICE = eigenes Design; fremde Organisation und archiviert werden abgelehnt; Archivieren eines zugeordneten Designs ebenfalls", async () => {
    const own = await saveLayoutDesign(orgId, { name: "Zuordnung" }, "tester");
    await assign({ INVOICE: own.ref });
    const foreign = await saveLayoutDesign(otherOrgId, { name: "Fremdes" }, "tester");
    await expect(saveBrandingSettings(orgId, { layoutByType: { INVOICE: foreign.ref } })).rejects.toThrow(/nicht gefunden oder archiviert/);
    await expect(archiveLayoutDesign(orgId, own.id, true, "tester")).rejects.toThrow(new InvalidOperationError("Design ist noch zugeordnet."));
    await assign({});
    expect((await archiveLayoutDesign(orgId, own.id, true, "tester")).archived).toBe(true);
    await expect(saveBrandingSettings(orgId, { layoutByType: { INVOICE: own.ref } })).rejects.toThrow(/nicht gefunden oder archiviert/);
    await assign({});
  });
});

describe("Einfrieren", () => {
  it("Rechnung: v1 beim Festschreiben eingefroren, v2 wirkt nur auf neue Entwuerfe, Archiv-PDF zeigt v1", async () => {
    const design = await saveLayoutDesign(orgId, { name: "Rechnung", baseLayoutId: "klassik" }, "tester");
    const v1 = (await listLayoutDesignVersions(orgId, design.id))[0];
    await assign({ INVOICE: design.ref });
    const draft = await createDraftInvoice(orgId, invoiceInput(), { now: ISSUE });
    const fin = await finalizeInvoice(draft.id, { now: ISSUE });
    const inv = await dbInternal.invoice.findUniqueOrThrow({ where: { id: fin.id }, select: { printOptionsJson: true } });
    const frozen = JSON.parse(inv.printOptionsJson ?? "{}") as { layoutId?: string; layoutVersionId?: string };
    expect(frozen.layoutVersionId).toBe(v1.id);
    expect(frozen.layoutId).toBe("klassik");

    const themeV1 = await loadPdfTheme(orgId, inv.printOptionsJson, "INVOICE");
    await saveLayoutDesign(orgId, { id: design.id, name: "Rechnung", config: withPrimary(design.config, "#bb0000") }, "tester");
    const themeAfter = await loadPdfTheme(orgId, inv.printOptionsJson, "INVOICE");
    expect(themeAfter.layoutConfig?.colors.primary).toBe(design.config.colors.primary);
    expect(themeAfter.layoutVersionId).toBe(v1.id);
    expect((await loadPdfTheme(orgId, null, "INVOICE")).layoutConfig?.colors.primary).toBe("#bb0000");

    const loaded = await loadEInvoiceData(fin.id);
    if (!loaded) throw new Error("Rechnung fehlt");
    const expected = normalizedPdfHash(await renderZugferdPdf(loaded.data, themeV1, buildFacturXCII(loaded.data)));
    const set = await ensureInvoiceArchive(orgId, fin.id, "OUTPUT", new Date("2120-06-01T10:00:00.000Z"));
    const archived = await readArchiveFile(set.PDF.path);
    expect(archived).not.toBeNull();
    expect(normalizedPdfHash(archived as Buffer)).toBe(expected);
    const v2Theme = await loadPdfTheme(orgId, null, "INVOICE");
    expect(normalizedPdfHash(await renderZugferdPdf(loaded.data, v2Theme, buildFacturXCII(loaded.data)))).not.toBe(expected);
  });

  it("Mahnung: Version bei der Erstellung eingefroren, Archiv rendert mit ihr", async () => {
    const design = await saveLayoutDesign(orgId, { name: "Mahnung", baseLayoutId: "standard" }, "tester");
    const v1 = (await listLayoutDesignVersions(orgId, design.id))[0];
    await assign({ DUNNING: design.ref });
    const draft = await createDraftInvoice(orgId, invoiceInput(), { now: ISSUE });
    const fin = await finalizeInvoice(draft.id, { now: ISSUE });
    const { dunning } = await createDunning(fin.id, { now: DUNNING_AT, force: true });
    expect(dunning.layoutVersionId).toBe(v1.id);
    await saveLayoutDesign(orgId, { id: design.id, name: "Mahnung", config: withPrimary(design.config, "#cc0000") }, "tester");
    const entry = await ensureDunningArchive(orgId, dunning.id);
    const row = await dbInternal.dunning.findFirstOrThrow({ where: { id: dunning.id }, include: { invoice: { include: { org: true, customer: true } }, stage: true } });
    const render = async (versionId: string | null) => renderDunningPdf(buildDunningPdfData(row, row.invoice), await loadPdfTheme(orgId, null, "DUNNING", { layoutVersionId: versionId }));
    const archived = await readArchiveFile(entry.path);
    expect(archived).not.toBeNull();
    expect(normalizedPdfHash(archived as Buffer)).toBe(normalizedPdfHash(await render(v1.id)));
    expect(normalizedPdfHash(await render(null))).not.toBe(normalizedPdfHash(archived as Buffer));
    await assign({});
  });
});

describe("Festes Layout und archivierte Designs", () => {
  it("Mahnung mit unbekannter eingefrorener Version rendert ohne Fehler mit der aktuellen Zuordnung", async () => {
    const design = await saveLayoutDesign(orgId, { name: "Fehlendes Ziel" }, "tester");
    await assign({ DUNNING: design.ref });
    const current = await loadPdfTheme(orgId, null, "DUNNING");
    const missing = await loadPdfTheme(orgId, null, "DUNNING", { layoutVersionId: "cnichtvorhanden00000000000" });
    expect(missing.layoutConfig).toEqual(current.layoutConfig);
    await assign({});
  });

  it("Mahnung ohne eingefrorene Version rendert nie mit einem spaeter zugeordneten Design", async () => {
    await assign({});
    const draft = await createDraftInvoice(orgId, invoiceInput(), { now: ISSUE });
    const fin = await finalizeInvoice(draft.id, { now: ISSUE });
    const { dunning } = await createDunning(fin.id, { now: DUNNING_AT, force: true });
    expect(dunning.layoutVersionId).toBeNull();
    const design = await saveLayoutDesign(orgId, { name: "Spaeter zugeordnet" }, "tester");
    await saveLayoutDesign(orgId, { id: design.id, name: "Spaeter zugeordnet", config: withPrimary(design.config, "#dd0000") }, "tester");
    await assign({ DUNNING: design.ref });
    const entry = await ensureDunningArchive(orgId, dunning.id);
    const row = await dbInternal.dunning.findFirstOrThrow({ where: { id: dunning.id }, include: { invoice: { include: { org: true, customer: true } }, stage: true } });
    const render = async (fixed: boolean) =>
      renderDunningPdf(buildDunningPdfData(row, row.invoice), await loadPdfTheme(orgId, null, "DUNNING", fixed ? { fixedLayoutOnly: true } : {}));
    const archived = normalizedPdfHash((await readArchiveFile(entry.path)) as Buffer);
    expect(archived).toBe(normalizedPdfHash(await render(true)));
    expect(archived).not.toBe(normalizedPdfHash(await render(false)));
    await assign({});
  });

  it("Design nach dem Festschreiben archiviert: Neuausgabe rendert weiter mit v1", async () => {
    const design = await saveLayoutDesign(orgId, { name: "Spaeter archiviert", baseLayoutId: "klassik" }, "tester");
    await assign({ INVOICE: design.ref });
    const draft = await createDraftInvoice(orgId, invoiceInput(), { now: ISSUE });
    const fin = await finalizeInvoice(draft.id, { now: ISSUE });
    const inv = await dbInternal.invoice.findUniqueOrThrow({ where: { id: fin.id }, select: { printOptionsJson: true } });
    const themeV1 = await loadPdfTheme(orgId, inv.printOptionsJson, "INVOICE");
    await assign({});
    await archiveLayoutDesign(orgId, design.id, true, "tester");
    const loaded = await loadEInvoiceData(fin.id);
    if (!loaded) throw new Error("Rechnung fehlt");
    const set = await ensureInvoiceArchive(orgId, fin.id, "OUTPUT", new Date("2120-06-02T10:00:00.000Z"));
    expect(normalizedPdfHash((await readArchiveFile(set.PDF.path)) as Buffer)).toBe(normalizedPdfHash(await renderZugferdPdf(loaded.data, themeV1, buildFacturXCII(loaded.data))));
    expect(themeV1.layoutConfig).toBeDefined();
  });
});

describe("Rueckfall und Druckoptionen", () => {
  it("Version einer fremden Organisation im Beleg-JSON: Theme ohne layoutConfig, layoutId aus dem JSON, kein Wurf", async () => {
    const foreign = await saveLayoutDesign(otherOrgId, { name: "Fremd-Version" }, "tester");
    const fv = (await listLayoutDesignVersions(otherOrgId, foreign.id))[0];
    const json = JSON.stringify({ layoutId: "modern", layoutVersionId: fv.id });
    const theme = await loadPdfTheme(orgId, json, "INVOICE");
    expect(theme.layoutConfig).toBeUndefined();
    expect(theme.layoutVersionId).toBeUndefined();
    expect(theme.layoutId).toBe("modern");
    const sel = await resolveLayoutSelection(dbInternal, orgId, { ref: "design:cnichtvorhandenabcdefghi" });
    expect(sel).toEqual({ layoutId: "standard", layoutVersionId: null, config: null });
  });

  it("setPrintOptions entfernt layoutVersionId", async () => {
    const draft = await createDraftInvoice(orgId, invoiceInput(), { now: ISSUE });
    await setPrintOptions(orgId, { kind: "INVOICE", id: draft.id }, { showFooter: false, layoutVersionId: "x" });
    const row = await dbInternal.invoice.findUniqueOrThrow({ where: { id: draft.id }, select: { printOptionsJson: true } });
    expect(JSON.parse(row.printOptionsJson ?? "{}")).toEqual({ showFooter: false });
  });
});
