/**
 * Eingangsrechnungen Arbeitsablauf: Status, Zuordnung, Notiz, Kopfdaten von Hand, Lieferant,
 * IBAN-Wechsel, Faelligkeit. Testjahr 2241.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dbInternal } from "@/lib/db";
import { resetRateLimits } from "@/lib/rate-limit";
import { receiveIncomingInvoice } from "@/domain/incoming/receive";
import { changeIncomingStatus } from "@/domain/incoming/status";
import { updateIncomingInvoice } from "@/domain/incoming/update";
import { createContactFromIncoming, suggestSupplierContacts } from "@/domain/incoming/supplier";
import { incomingHistory } from "@/domain/incoming/history";
import { ibanOfPayment, previousSupplierIban } from "@/domain/incoming/payment-check";
import { processIncomingDue } from "@/domain/incoming/due-notify";
import { countIncomingByStatus, getIncomingInvoiceDetail, listIncomingInvoices } from "@/domain/incoming/list";
import { IncomingWorkflowError } from "@/domain/incoming/errors";
import { verifyOrgChain } from "@/domain/audit/verify-chain";
import type { NotificationType } from "@/domain/notifications/settings";

const BASE = fs.readFileSync(path.resolve(__dirname, "../fixtures/incoming/gen-base-ubl.xml"), "utf8");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==", "base64");
const IBAN_A = "DE02120300000000202051";
const IBAN_B = "DE89370400440532013000";
const NOW = new Date("2241-03-10T10:00:00.000Z");
const actor = "tester";

let tmp = "";
let prevDir: string | undefined;
let orgId = "";
let otherOrgId = "";
let seq = 0;

interface Opts {
  number?: string;
  iban?: string;
  due?: string | null;
  vat?: string;
  name?: string;
  street?: boolean;
}
function ubl(o: Opts = {}): Buffer {
  seq += 1;
  let x = BASE.replace("<cbc:ID>RE-2026-0001</cbc:ID>", `<cbc:ID>${o.number ?? `W-${seq}`}</cbc:ID>`).replaceAll(IBAN_A, o.iban ?? IBAN_A);
  if (o.due === null) x = x.replace(/<cbc:DueDate>[^<]*<\/cbc:DueDate>\s*/, "");
  else if (o.due) x = x.replace("<cbc:DueDate>2026-06-23</cbc:DueDate>", `<cbc:DueDate>${o.due}</cbc:DueDate>`);
  if (o.vat) x = x.replace("DE123456789", o.vat);
  if (o.name) x = x.replace("Muster Handwerk GmbH", o.name);
  return Buffer.from(x, "utf8");
}
async function receive(bytes: Buffer, at: Date = NOW, org: string = orgId): Promise<string> {
  const r = await receiveIncomingInvoice(org, bytes, { fileName: `r${seq}.xml`, channel: "UPLOAD", actor, now: at });
  return r.id;
}
const png = (): Buffer => Buffer.concat([PNG, Buffer.from(`${(seq += 1)}`)]);
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof IncomingWorkflowError ? e.code : e instanceof Error ? e.message : "?";
  }
};

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "incoming-workflow-"));
  prevDir = process.env.ARCHIVE_DIR;
  process.env.ARCHIVE_DIR = tmp;
  const mk = async (n: string) =>
    (await dbInternal.organization.create({ data: { legalName: `Eingang Ablauf ${n} GmbH`, addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" }, select: { id: true } })).id;
  orgId = await mk("A");
  otherOrgId = await mk("B");
});

afterAll(async () => {
  if (prevDir === undefined) delete process.env.ARCHIVE_DIR;
  else process.env.ARCHIVE_DIR = prevDir;
  await fsp.rm(tmp, { recursive: true, force: true });
});

beforeEach(() => resetRateLimits());

describe("Status", () => {
  it("kompletter Durchlauf mit Protokoll und intakter Kette", async () => {
    const id = await receive(ubl());
    await changeIncomingStatus(orgId, id, { action: "CHECK" }, actor, NOW);
    await changeIncomingStatus(orgId, id, { action: "APPROVE" }, actor, NOW);
    const h = await changeIncomingStatus(orgId, id, { action: "MARK_PAID", paidOn: "2241-03-09", paidNote: "Bank 1" }, actor, NOW);
    expect(h.status).toBe("PAID");
    expect(h.paidMarkedAt?.toISOString()).toBe("2241-03-09T00:00:00.000Z");
    const log = await dbInternal.changeLog.findMany({ where: { orgId, entity: "INCOMING_INVOICE", entityId: id }, orderBy: { id: "asc" }, select: { action: true } });
    expect(log.map((l) => l.action)).toEqual(["RECEIVE", "STATUS", "STATUS", "STATUS"]);
    expect((await verifyOrgChain(orgId, "CLI")).valid).toBe(true);
    const hist = await incomingHistory(orgId, id);
    expect(hist).toHaveLength(4);
    expect(hist[0]?.summary).toMatchObject({ action: "MARK_PAID", from: "APPROVED", to: "PAID", paidOn: "2241-03-09" });
    expect(JSON.stringify(hist)).not.toContain("Bank 1");
  });

  it("Ablehnen ohne Grund -> REASON_REQUIRED (400)", async () => {
    const id = await receive(ubl());
    expect(await code(changeIncomingStatus(orgId, id, { action: "REJECT" }, actor, NOW))).toBe("REASON_REQUIRED");
    const e = await changeIncomingStatus(orgId, id, { action: "REJECT", reason: "Irrlaeufer" }, actor, NOW);
    expect(e.status).toBe("REJECTED");
    expect(new IncomingWorkflowError("x", "REASON_REQUIRED").status).toBe(400);
  });

  it("Zuruecksetzen von PAID leert den Zahlungsmerker", async () => {
    const id = await receive(ubl());
    for (const action of ["CHECK", "APPROVE", "MARK_PAID"] as const) await changeIncomingStatus(orgId, id, { action }, actor, NOW);
    const h = await changeIncomingStatus(orgId, id, { action: "REVERT", reason: "Irrtum" }, actor, NOW);
    expect(h.status).toBe("APPROVED");
    expect(h.paidMarkedAt).toBeNull();
    expect(await code(changeIncomingStatus(orgId, id, { action: "CHECK" }, actor, NOW))).toBe("INVALID_TRANSITION");
  });

  it("zwei gleichzeitige CHECK: einer gewinnt, ein Protokolleintrag", async () => {
    const id = await receive(ubl());
    const res = await Promise.all([
      code(changeIncomingStatus(orgId, id, { action: "CHECK" }, actor, NOW)),
      code(changeIncomingStatus(orgId, id, { action: "CHECK" }, actor, NOW)),
    ]);
    expect(res.filter((r) => r === "OK")).toHaveLength(1);
    expect(res.filter((r) => r === "STATUS_CONFLICT" || r === "INVALID_TRANSITION")).toHaveLength(1);
    expect(await dbInternal.changeLog.count({ where: { orgId, entityId: id, action: "STATUS" } })).toBe(1);
  });

  it("fremde Organisation: nicht gefunden", async () => {
    const id = await receive(ubl());
    await expect(changeIncomingStatus(otherOrgId, id, { action: "CHECK" }, actor, NOW)).rejects.toThrow("nicht gefunden");
  });

  it("Zahldatum in der Zukunft: PAID_DATE_INVALID", async () => {
    const id = await receive(ubl());
    await changeIncomingStatus(orgId, id, { action: "CHECK" }, actor, NOW);
    await changeIncomingStatus(orgId, id, { action: "APPROVE" }, actor, NOW);
    expect(await code(changeIncomingStatus(orgId, id, { action: "MARK_PAID", paidOn: "2241-03-11" }, actor, NOW))).toBe("PAID_DATE_INVALID");
  });
});

describe("Zuordnung, Notiz, Kopfdaten von Hand", () => {
  it("fremder Kontakt: CONTACT_NOT_FOUND; Zuordnung in APPROVED gesperrt", async () => {
    const foreign = await dbInternal.customer.create({ data: { orgId: otherOrgId, name: "Fremd", addressLine1: "a", postalCode: "1", city: "c" }, select: { id: true } });
    const own = await dbInternal.customer.create({ data: { orgId, name: "Eigen", addressLine1: "a", postalCode: "1", city: "c" }, select: { id: true } });
    const id = await receive(ubl());
    expect(await code(updateIncomingInvoice(orgId, id, { supplierContactId: foreign.id }, actor, NOW))).toBe("CONTACT_NOT_FOUND");
    const h = await updateIncomingInvoice(orgId, id, { supplierContactId: own.id }, actor, NOW);
    expect(h.supplierContactId).toBe(own.id);
    await changeIncomingStatus(orgId, id, { action: "CHECK" }, actor, NOW);
    await changeIncomingStatus(orgId, id, { action: "APPROVE" }, actor, NOW);
    expect(await code(updateIncomingInvoice(orgId, id, { supplierContactId: null }, actor, NOW))).toBe("STATUS_LOCKED");
  });

  it("Notiz in jedem Status, Protokoll nur mit Pruefsumme; Original und Kopffelder unveraendert", async () => {
    const id = await receive(ubl());
    const before = await dbInternal.incomingInvoice.findUniqueOrThrow({ where: { id }, select: { originalSha256: true, number: true, grossCents: true, dueDate: true, supplierName: true } });
    for (const action of ["CHECK", "APPROVE", "MARK_PAID"] as const) await changeIncomingStatus(orgId, id, { action }, actor, NOW);
    await updateIncomingInvoice(orgId, id, { internalNote: "geheime Notiz 4711" }, actor, NOW);
    const log = await dbInternal.changeLog.findMany({ where: { orgId, entityId: id }, select: { diffJson: true } });
    const all = log.map((l) => l.diffJson).join("\n");
    expect(all).not.toContain("geheime Notiz");
    expect(all).toContain("sha256");
    const detail = await getIncomingInvoiceDetail(orgId, id, { ibanMode: "full" }, NOW);
    expect(detail.internalNote).toBe("geheime Notiz 4711");
    expect(await dbInternal.incomingInvoice.findUniqueOrThrow({ where: { id }, select: { originalSha256: true, number: true, grossCents: true, dueDate: true, supplierName: true } })).toEqual(before);
    const list = await listIncomingInvoices(orgId, {}, NOW);
    expect(JSON.stringify(list)).not.toContain("geheime Notiz");
    expect(Object.keys(list.rows[0] ?? {})).not.toContain("internalNote");
    await updateIncomingInvoice(orgId, id, { internalNote: "  " }, actor, NOW);
    expect((await getIncomingInvoiceDetail(orgId, id, { ibanMode: "full" }, NOW)).internalNote).toBeNull();
  });

  const manual = { supplierName: "Scan Lieferant", number: "SC-1", issueDate: "2241-03-01", grossCents: 11900, dueDate: "2241-03-20" };

  it("Kopfdaten von Hand: bei UBL nicht erlaubt, bei Bild ja (dueAt), null leert", async () => {
    const x = await receive(ubl());
    expect(await code(updateIncomingInvoice(orgId, x, { manual }, actor, NOW))).toBe("MANUAL_NOT_ALLOWED");
    const id = await receive(png());
    const h = await updateIncomingInvoice(orgId, id, { manual }, actor, NOW);
    expect(h.dueAt?.toISOString()).toBe("2241-03-20T00:00:00.000Z");
    const d = await getIncomingInvoiceDetail(orgId, id, { ibanMode: "masked" }, NOW);
    expect(d.manual).toMatchObject({ number: "SC-1", currency: "EUR" });
    const c = await updateIncomingInvoice(orgId, id, { manual: null }, actor, NOW);
    expect(c.dueAt).toBeNull();
    expect(c.manualJson).toBeNull();
    expect(await code(updateIncomingInvoice(orgId, id, {}, actor, NOW))).not.toBe("OK");
  });
});

describe("Lieferant", () => {
  it("Vorschlaege: USt-IdNr. mit Leerzeichen und Name mit Rechtsform", async () => {
    const byVat = await dbInternal.customer.create({ data: { orgId, name: "Ganz anders", vatId: "DE 111 222 333", addressLine1: "a", postalCode: "1", city: "c" }, select: { id: true } });
    const byName = await dbInternal.customer.create({ data: { orgId, name: "Zeta-Werke", addressLine1: "a", postalCode: "1", city: "c" }, select: { id: true } });
    await dbInternal.customer.create({ data: { orgId: otherOrgId, name: "Zeta-Werke", vatId: "DE111222333", addressLine1: "a", postalCode: "1", city: "c" } });
    const s = await suggestSupplierContacts(orgId, { supplierVatId: "DE111222333", supplierName: "Zeta Werke GmbH" });
    expect(s.map((x) => [x.id, x.match])).toEqual([
      [byVat.id, "VAT_ID"],
      [byName.id, "NAME"],
    ]);
  });

  it("Kontakt aus dem Snapshot anlegen: Kontakt, Zuordnung, Protokoll", async () => {
    const id = await receive(ubl({ vat: "DE555666777", name: "Snapshot Handel GmbH" }));
    const r = await createContactFromIncoming(orgId, id, {}, actor, NOW);
    const c = await dbInternal.customer.findUniqueOrThrow({ where: { id: r.contactId }, select: { orgId: true, name: true, vatId: true, city: true, countryCode: true } });
    expect(c).toMatchObject({ orgId, name: "Snapshot Handel GmbH", vatId: "DE555666777", countryCode: "DE" });
    expect(r.header.supplierContactId).toBe(r.contactId);
    const log = await dbInternal.changeLog.findFirstOrThrow({ where: { orgId, entityId: id, action: "UPDATE" }, select: { diffJson: true } });
    expect(log.diffJson).toContain("contactCreated");
    expect(await code(createContactFromIncoming(orgId, id, {}, actor, NOW))).toBe("ALREADY_ASSIGNED");
  });

  it("ohne Anschrift: CONTACT_INCOMPLETE mit Feldern, mit Ueberschreibungen ok", async () => {
    const id = await receive(png());
    await updateIncomingInvoice(orgId, id, { manual: { supplierName: "Nur Name KG", number: "N-1", issueDate: "2241-03-01", grossCents: 100 } }, actor, NOW);
    try {
      await createContactFromIncoming(orgId, id, {}, actor, NOW);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(IncomingWorkflowError);
      const err = e as IncomingWorkflowError;
      expect(err.code).toBe("CONTACT_INCOMPLETE");
      expect(err.status).toBe(422);
      expect(err.details?.fields).toEqual(expect.arrayContaining(["addressLine1", "postalCode", "city", "countryCode"]));
    }
    const r = await createContactFromIncoming(orgId, id, { addressLine1: "Weg 2", postalCode: "10115", city: "Berlin", countryCode: "DE" }, actor, NOW);
    expect(r.header.supplierContactId).toBe(r.contactId);
  });
});

describe("IBAN-Wechsel", () => {
  it("FIRST_IBAN, IBAN_CHANGED, gleiche IBAN keine Warnung, REJECTED ignoriert, REST maskiert", async () => {
    const vat = "DE900800700";
    const t = (n: number) => new Date(NOW.getTime() + n * 60_000);
    const first = await receive(ubl({ vat, name: "IBAN Test GmbH", iban: IBAN_A }), t(1));
    const second = await receive(ubl({ vat, name: "IBAN Test GmbH", iban: IBAN_B }), t(2));
    const third = await receive(ubl({ vat, name: "IBAN Test GmbH", iban: IBAN_B }), t(3));
    expect((await getIncomingInvoiceDetail(orgId, first, { ibanMode: "full" }, NOW)).ibanWarning?.code).toBe("FIRST_IBAN");
    const w = (await getIncomingInvoiceDetail(orgId, second, { ibanMode: "full" }, NOW)).ibanWarning;
    expect(w?.code).toBe("IBAN_CHANGED");
    expect(w?.previous?.iban).toBe(IBAN_A);
    const masked = await getIncomingInvoiceDetail(orgId, second, { ibanMode: "masked" }, NOW);
    expect(JSON.stringify(masked.ibanWarning)).not.toContain(IBAN_A);
    expect(masked.payment?.girocodes).toEqual([]);
    expect(masked.payment?.iban).not.toBe(IBAN_B);
    expect((await getIncomingInvoiceDetail(orgId, third, { ibanMode: "full" }, NOW)).ibanWarning).toBeNull();
    // Vorgaenger abgelehnt -> zaehlt nicht mehr
    await changeIncomingStatus(orgId, second, { action: "REJECT", reason: "Betrugsverdacht" }, actor, NOW);
    expect((await getIncomingInvoiceDetail(orgId, third, { ibanMode: "full" }, NOW)).ibanWarning?.code).toBe("IBAN_CHANGED");
  });
});

describe("IBAN-Vergleich", () => {
  it("viele fremde Lieferanten mit gleichem Laendercode verdraengen den Vorgaenger nicht", async () => {
    const vat = "DE700800700";
    const t = (n: number) => new Date(NOW.getTime() + n * 3_600_000);
    await receive(ubl({ vat, name: "Vorgaenger Test GmbH", iban: IBAN_A }), t(1));
    for (let i = 0; i < 60; i++) {
      if (i % 20 === 0) resetRateLimits();
      await receive(ubl({ vat: `DE61${String(i).padStart(5, "0")}`, name: `Fremd ${i} GmbH`, iban: IBAN_B }), t(2 + i / 100));
    }
    resetRateLimits();
    const next = await receive(ubl({ vat, name: "Vorgaenger Test GmbH", iban: IBAN_B }), t(5));
    const w = (await getIncomingInvoiceDetail(orgId, next, { ibanMode: "full" }, NOW)).ibanWarning;
    expect(w?.code).toBe("IBAN_CHANGED");
    expect(w?.previous?.iban).toBe(IBAN_A);
    // kleine Blockgroesse erzwingt mehrere Seiten
    const head = await dbInternal.incomingInvoice.findUniqueOrThrow({
      where: { id: next },
      select: { id: true, receivedAt: true, supplierContactId: true, supplierVatId: true, supplierName: true },
    });
    expect((await previousSupplierIban(orgId, head, 7))?.iban).toBe(IBAN_A);
  });

  it("Vergleichs- und aktuelle IBAN nutzen dieselbe Auswahlregel (Lastschrift zaehlt nicht)", () => {
    const means = (list: { code: string | null; iban: string | null }[]) =>
      JSON.stringify({ means: list.map((m) => ({ ...m, bic: null, accountName: null, cardLast4: null, mandateRef: null })), terms: null, dueDate: null, remittance: null });
    expect(ibanOfPayment(means([{ code: "59", iban: IBAN_B }, { code: "58", iban: IBAN_A }]))).toBe(IBAN_A);
    expect(ibanOfPayment(means([{ code: "59", iban: IBAN_B }]))).toBeNull();
    expect(ibanOfPayment(means([{ code: null, iban: IBAN_A }]))).toBe(IBAN_A);
  });
});

describe("Zuordnung und Faelligkeit (Randfaelle)", () => {
  it("Kontakt-Anlage aus Rechnung einer fremden Organisation ist identisch zu unbekannter Id (404)", async () => {
    const id = await receive(ubl({ vat: "DE555000111", name: "Fremd Handel GmbH" }));
    const foreign = await createContactFromIncoming(otherOrgId, id, {}, actor, NOW).catch((e: unknown) => e);
    const missing = await createContactFromIncoming(otherOrgId, "gibt-es-nicht", {}, actor, NOW).catch((e: unknown) => e);
    expect(foreign).toBeInstanceOf(Error);
    expect((foreign as Error).constructor).toBe((missing as Error).constructor);
    expect((foreign as Error).message).toBe((missing as Error).message);
    expect(await dbInternal.customer.count({ where: { orgId: otherOrgId, vatId: "DE555000111" } })).toBe(0);
  });

  it("mehr offene Rechnungen als eine Blockgroesse: alle werden gemeldet; Wechsel auf ueberfaellig meldet neu", async () => {
    const o = await dbInternal.organization.create({ data: { legalName: "Eingang Faellig Bloecke GmbH", addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" }, select: { id: true } });
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(await receive(ubl({ due: "2241-06-17" }), NOW, o.id));
    const on: Set<NotificationType> = new Set(["INCOMING_DUE"]);
    const by: Record<string, number> = {};
    await processIncomingDue(o.id, new Date("2241-06-15T10:00:00.000Z"), on, by, 3);
    expect(by.INCOMING_DUE).toBe(7);
    const later: Record<string, number> = {};
    await processIncomingDue(o.id, new Date("2241-06-20T10:00:00.000Z"), on, later, 3);
    expect(later.INCOMING_DUE).toBe(7);
    const titles = (await dbInternal.notification.findMany({ where: { orgId: o.id, type: "INCOMING_DUE" }, select: { title: true } })).map((n) => n.title);
    expect(titles.filter((x) => x.includes("ueberfaellig seit 17.06.2241"))).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);
  });
});

describe("Faelligkeit", () => {
  const today = new Date("2241-06-15T10:00:00.000Z");
  let soon = "";
  let late = "";
  let far = "";
  let paid = "";

  beforeAll(async () => {
    const o = await dbInternal.organization.create({ data: { legalName: "Eingang Faellig GmbH", addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" }, select: { id: true } });
    const org = o.id;
    soon = await receive(ubl({ due: "2241-06-17", name: "Soon AG" }), NOW, org);
    late = await receive(ubl({ due: "2241-06-10", name: "Late AG" }), NOW, org);
    far = await receive(ubl({ due: "2241-09-01", name: "Far AG" }), NOW, org);
    paid = await receive(ubl({ due: "2241-06-10", name: "Paid AG" }), NOW, org);
    for (const action of ["CHECK", "APPROVE", "MARK_PAID"] as const) await changeIncomingStatus(org, paid, { action }, actor, NOW);
    dueOrg = org;
  });
  let dueOrg = "";

  it("Listenfilter DUE_SOON und OVERDUE, Zaehler", async () => {
    const ids = async (due: string) => (await listIncomingInvoices(dueOrg, { due }, today)).rows.map((r) => r.id).sort();
    expect(await ids("DUE_SOON")).toEqual([soon, late].sort());
    expect(await ids("OVERDUE")).toEqual([late]);
    const counts = await countIncomingByStatus(dueOrg, today);
    expect(counts).toMatchObject({ DUE_SOON: 2, NEW: 3, PAID: 1 });
    expect(far).not.toBe("");
  });

  it("processIncomingDue: eine Meldung je Rechnung, zweiter Lauf keine, abgewaehlt keine, PAID keine", async () => {
    const off: Set<NotificationType> = new Set();
    const byOff: Record<string, number> = {};
    await processIncomingDue(dueOrg, today, off, byOff);
    expect(byOff.INCOMING_DUE).toBeUndefined();

    const on: Set<NotificationType> = new Set(["INCOMING_DUE"]);
    const by: Record<string, number> = {};
    await processIncomingDue(dueOrg, today, on, by);
    expect(by.INCOMING_DUE).toBe(2);
    const again: Record<string, number> = {};
    await processIncomingDue(dueOrg, today, on, again);
    expect(again.INCOMING_DUE).toBeUndefined();
    const notes = await dbInternal.notification.findMany({ where: { orgId: dueOrg, type: "INCOMING_DUE" }, select: { title: true, link: true, entityId: true } });
    expect(notes).toHaveLength(2);
    expect(notes.map((n) => n.entityId)).not.toContain(paid);
    expect(notes.find((n) => n.entityId === late)?.title).toMatch(/ueberfaellig seit 10\.06\.2241/);
    expect(notes.find((n) => n.entityId === soon)?.title).toMatch(/faellig am 17\.06\.2241/);
    expect(notes.find((n) => n.entityId === soon)?.link).toBe(`/eingang/${soon}`);
  });
});

describe("Faelligkeit ohne BT-9", () => {
  it("Datei ohne Faelligkeit: dueAt bleibt leer", async () => {
    const id = await receive(ubl({ due: null }));
    const r = await dbInternal.incomingInvoice.findUniqueOrThrow({ where: { id }, select: { dueDate: true, dueAt: true } });
    expect(r).toEqual({ dueDate: null, dueAt: null });
  });
});
