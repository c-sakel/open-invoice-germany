/**
 * Phase 16e, Task 5 — OSS-Benachrichtigungen (`checkOssNotifications`, Job, Hook nach Festschreiben)
 * und Einstellungsformular-Action (Review F1). Testjahre 2118 + 2119 (Invoice.number global eindeutig).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { saveDocumentSettings, loadDocumentSettings } from "@/domain/document/settings";
import { ALL_NOTIFICATION_TYPES, saveNotificationSettings, type NotificationType } from "@/domain/notifications/settings";
import { runNotificationsJob } from "@/domain/notifications/job";
import { checkOssNotifications } from "@/domain/reporting/oss-notify";
import { OSS_NOTICE } from "@/schemas/oss";
import { createInvoiceSchema } from "@/schemas";

vi.mock("@/lib/org", () => ({ getActiveOrg: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/domain/reporting/oss", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/domain/reporting/oss")>();
  return { ...orig, ossThreshold: vi.fn(orig.ossThreshold) };
});

import { ossThreshold } from "@/domain/reporting/oss";
import { getActiveOrg } from "@/lib/org";
import { saveDocumentSettingsAction } from "@/app/actions/document-settings";

const NOW = new Date("2119-06-01T10:00:00.000Z");
const PREV = new Date("2118-06-01T10:00:00.000Z");
let seq = 0;

interface Ctx {
  orgId: string;
  at: string;
  de: string;
}

async function mk(): Promise<Ctx> {
  seq += 1;
  const tag = `ON${seq}`;
  const org = await dbInternal.organization.create({
    data: { legalName: `OSS-Notify ${tag} GmbH`, addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: `DE2119${String(seq).padStart(5, "0")}`, taxNumber: "21/119/00000" },
  });
  const orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  for (const year of [2118, 2119]) {
    await dbInternal.numberRange.upsert({
      where: { orgId_docType_year: { orgId, docType: "INVOICE", year } },
      create: { orgId, docType: "INVOICE", year, currentValue: 0, prefix: `${tag}R-`, pattern: "{PREFIX}{YYYY}-{SEQ}", seqPadding: 4, isActive: true },
      update: {},
    });
  }
  const cust = async (name: string, countryCode: string) =>
    (await dbInternal.customer.create({ data: { orgId, name, addressLine1: "Weg 1", postalCode: "1010", city: "Ort", countryCode, vatId: null, type: "PRIVATE" } })).id;
  return { orgId, at: await cust("AT privat", "AT"), de: await cust("DE privat", "DE") };
}

/** Typ OSS_THRESHOLD an- bzw. abwaehlen (alle anderen bleiben aktiv). */
async function setOssEnabled(orgId: string, on: boolean) {
  const enabledTypes = ALL_NOTIFICATION_TYPES.filter((t): t is NotificationType => on || t !== "OSS_THRESHOLD");
  await saveNotificationSettings(orgId, { enabledTypes, emailDigest: false });
}

async function invoice(orgId: string, customerId: string, netCents: number, now: Date = NOW) {
  const d = await createDraftInvoice(
    orgId,
    createInvoiceSchema.parse({
      customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR", issueDate: now, deliveryDate: now,
      lines: [{ description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: netCents, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
    }),
    { now },
  );
  return finalizeInvoice(d.id, { now });
}

const ossNotes = (orgId: string) => dbInternal.notification.findMany({ where: { orgId, type: "OSS_THRESHOLD" }, orderBy: { createdAt: "asc" } });

beforeEach(() => {
  vi.mocked(ossThreshold).mockClear();
});

describe("checkOssNotifications", () => {
  it("80 %, dann Ueberschreitung; jede Stufe nur einmal", async () => {
    const c = await mk();
    await setOssEnabled(c.orgId, false); // Hook beim Festschreiben ausschalten, hier wird direkt geprueft
    await invoice(c.orgId, c.at, 790000);
    expect(await checkOssNotifications(c.orgId, NOW)).toBe(0);
    await invoice(c.orgId, c.at, 10000);
    expect(await checkOssNotifications(c.orgId, NOW)).toBe(1);
    const [warn] = await ossNotes(c.orgId);
    expect(warn!.dedupeKey).toBe("oss-2119-80");
    expect(warn!.title).toBe("EU-Fernverkäufe: 80 % der OSS-Schwelle erreicht");
    expect(warn!.body!.endsWith(OSS_NOTICE)).toBe(true);
    expect(warn!.link).toBe("/");
    expect(await checkOssNotifications(c.orgId, NOW)).toBe(0);

    await invoice(c.orgId, c.at, 200001);
    expect(await checkOssNotifications(c.orgId, NOW)).toBe(1);
    const all = await ossNotes(c.orgId);
    expect(all).toHaveLength(2);
    expect(all[1]!.dedupeKey).toBe("oss-2119-100");
    expect(all[1]!.title).toBe("OSS-Schwelle von 10.000 € überschritten");
  });

  it("genau 10.000,00 € ist nur die Warnstufe", async () => {
    const c = await mk();
    await setOssEnabled(c.orgId, false);
    await invoice(c.orgId, c.at, 1_000_000);
    expect(await checkOssNotifications(c.orgId, NOW)).toBe(1);
    expect((await ossNotes(c.orgId))[0]!.dedupeKey).toBe("oss-2119-80");
  });

  it("Warnschwelle 70 % -> Schluessel oss-2119-70", async () => {
    const c = await mk();
    await setOssEnabled(c.orgId, false);
    await saveDocumentSettings(c.orgId, { ...(await loadDocumentSettings(c.orgId)), ossWarnPercent: 70 });
    await invoice(c.orgId, c.at, 700000);
    expect(await checkOssNotifications(c.orgId, NOW)).toBe(1);
    expect((await ossNotes(c.orgId))[0]!.dedupeKey).toBe("oss-2119-70");
  });

  it("Vorjahr ueber 10.000 €, laufendes Jahr leer -> Hinweis auf das ganze Jahr", async () => {
    const c = await mk();
    await setOssEnabled(c.orgId, false);
    await invoice(c.orgId, c.at, 1_100_000, PREV);
    expect(await checkOssNotifications(c.orgId, NOW)).toBe(1);
    const [n] = await ossNotes(c.orgId);
    expect(n!.dedupeKey).toBe("oss-2119-100");
    expect(n!.title).toBe("OSS-Schwelle im Vorjahr überschritten — gilt das ganze Jahr");
  });
});

describe("Hook beim Festschreiben", () => {
  it("AT-Rechnung, die 80 % erreicht, benachrichtigt ohne Job-Lauf", async () => {
    const c = await mk();
    await invoice(c.orgId, c.at, 700000);
    expect(await ossNotes(c.orgId)).toHaveLength(0);
    await invoice(c.orgId, c.at, 100000);
    const notes = await ossNotes(c.orgId);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.dedupeKey).toBe("oss-2119-80");
  });

  it("DE-Rechnung loest keine OSS-Abfrage aus", async () => {
    const c = await mk();
    vi.mocked(ossThreshold).mockClear();
    await invoice(c.orgId, c.de, 900000);
    expect(ossThreshold).not.toHaveBeenCalled();
    expect(await ossNotes(c.orgId)).toHaveLength(0);
  });

  it("abgewaehlter Typ: Hook und Job legen nichts an", async () => {
    const c = await mk();
    await setOssEnabled(c.orgId, false);
    await invoice(c.orgId, c.at, 900000);
    expect(await ossNotes(c.orgId)).toHaveLength(0);
    const res = await runNotificationsJob(NOW, { orgId: c.orgId });
    expect(res.byType.OSS_THRESHOLD).toBeUndefined();
    expect(await ossNotes(c.orgId)).toHaveLength(0);
  });
});

describe("runNotificationsJob", () => {
  it("legt die Eintraege fuer das Jahr von now an und zaehlt sie in byType", async () => {
    const c = await mk();
    await setOssEnabled(c.orgId, false);
    await invoice(c.orgId, c.at, 900000);
    await setOssEnabled(c.orgId, true);
    const res = await runNotificationsJob(NOW, { orgId: c.orgId });
    expect(res.byType.OSS_THRESHOLD).toBe(1);
    expect((await ossNotes(c.orgId))[0]!.dedupeKey).toBe("oss-2119-80");
    const again = await runNotificationsJob(NOW, { orgId: c.orgId });
    expect(again.byType.OSS_THRESHOLD).toBeUndefined();
  });
});

describe("Beleg-Einstellungsformular (Review F1)", () => {
  it("Speichern ohne Aenderung behaelt per REST/MCP gesetzte OSS-Werte", async () => {
    const c = await mk();
    vi.mocked(getActiveOrg).mockResolvedValue({ id: c.orgId } as Awaited<ReturnType<typeof getActiveOrg>>);
    await saveDocumentSettings(c.orgId, { ...(await loadDocumentSettings(c.orgId)), ossCountMode: "BY_PRODUCT", ossWarnPercent: 65 });

    // Formular ohne OSS-Felder (aeltere Seite): Werte bleiben.
    const bare = new FormData();
    expect((await saveDocumentSettingsAction({ ok: false }, bare)).ok).toBe(true);
    let s = await loadDocumentSettings(c.orgId);
    expect(s.ossCountMode).toBe("BY_PRODUCT");
    expect(s.ossWarnPercent).toBe(65);

    // Formular mit den (unveraenderten) OSS-Feldern: Werte bleiben ebenfalls.
    const withFields = new FormData();
    withFields.set("ossCountMode", s.ossCountMode);
    withFields.set("ossWarnPercent", String(s.ossWarnPercent));
    expect((await saveDocumentSettingsAction({ ok: false }, withFields)).ok).toBe(true);
    s = await loadDocumentSettings(c.orgId);
    expect(s.ossCountMode).toBe("BY_PRODUCT");
    expect(s.ossWarnPercent).toBe(65);

    // Aenderung ueber das Formular wirkt.
    const changed = new FormData();
    changed.set("ossCountMode", "ALL_EU_B2C");
    changed.set("ossWarnPercent", "90");
    expect((await saveDocumentSettingsAction({ ok: false }, changed)).ok).toBe(true);
    s = await loadDocumentSettings(c.orgId);
    expect(s.ossCountMode).toBe("ALL_EU_B2C");
    expect(s.ossWarnPercent).toBe(90);
  });
});
