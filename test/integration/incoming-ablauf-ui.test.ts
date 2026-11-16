/**
 * Oberflaeche Eingang (Bearbeitung): Server-Actions nur fuer die eigene Firma, Grund beim Ablehnen,
 * Notiz speichern, Druckseite ohne Notiz. Testjahr 2244 (keine Belegnummern betroffen),
 * ARCHIVE_DIR im Tempverzeichnis, Pruefmaschine aus.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }), notFound: () => { throw new Error("notFound"); } }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "sec-fetch-site": "same-origin", host: "localhost" }) }));
vi.mock("@/lib/auth/server", () => ({ getCurrentUserId: async () => "tester" }));

import { dbInternal } from "@/lib/db";
import { resetRateLimits } from "@/lib/rate-limit";
import { receiveIncomingInvoice } from "@/domain/incoming/receive";
import { createContactFromIncomingAction, setIncomingStatusAction, updateIncomingAction } from "@/app/eingang/actions";
import EingangDruckPage from "@/app/eingang/[id]/druck/page";
import EingangDetailPage from "@/app/eingang/[id]/page";

const BASE = fs.readFileSync(path.resolve(__dirname, "../fixtures/incoming/gen-base-ubl.xml"), "utf8");
const ubl = (n: string): Buffer => Buffer.from(BASE.replace("<cbc:ID>RE-2026-0001</cbc:ID>", `<cbc:ID>${n}</cbc:ID>`), "utf8");
const NOTE = "Geheime-interne-Notiz-2244";

let tmp = "";
let prevDir: string | undefined;
let prevValidation: string | undefined;
let orgA = "";
let orgB = "";
let idA = "";
let idB = "";

async function mkOrg(name: string): Promise<string> {
  return (await dbInternal.organization.create({ data: { legalName: name, addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt", vatId: "DE111111111" }, select: { id: true } })).id;
}

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "incoming-ablauf-ui-"));
  prevDir = process.env.ARCHIVE_DIR;
  process.env.ARCHIVE_DIR = tmp;
  prevValidation = process.env.INCOMING_VALIDATION;
  process.env.INCOMING_VALIDATION = "off";
  orgA = await mkOrg("Eingang Ablauf Ui A GmbH");
  orgB = await mkOrg("Eingang Ablauf Ui B GmbH");
  const opts = { fileName: "rechnung.xml", channel: "UPLOAD" as const, actor: "tester" };
  idA = (await receiveIncomingInvoice(orgA, ubl("UI-2244-A"), opts)).id;
  idB = (await receiveIncomingInvoice(orgB, ubl("UI-2244-B"), opts)).id;
});
afterAll(async () => {
  orgStore.id = null;
  if (prevDir === undefined) delete process.env.ARCHIVE_DIR;
  else process.env.ARCHIVE_DIR = prevDir;
  if (prevValidation === undefined) delete process.env.INCOMING_VALIDATION;
  else process.env.INCOMING_VALIDATION = prevValidation;
  await fsp.rm(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  resetRateLimits();
  orgStore.id = orgA;
});

describe("Server-Actions der Bearbeitung", () => {
  it("fremde und unbekannte Ids liefern denselben Text", async () => {
    const foreign = await setIncomingStatusAction(idB, { action: "CHECK" });
    const unknown = await setIncomingStatusAction("gibt-es-nicht", { action: "CHECK" });
    expect(foreign).toEqual({ ok: false, error: "Eingangsrechnung nicht gefunden." });
    expect(unknown).toEqual(foreign);
    expect(await updateIncomingAction(idB, { internalNote: "x" })).toEqual(foreign);
    const c = await createContactFromIncomingAction(idB, {});
    expect(c).toEqual({ ok: false, error: "Eingangsrechnung nicht gefunden." });
    const other = await dbInternal.incomingInvoice.findFirstOrThrow({ where: { id: idB }, select: { status: true, internalNote: true } });
    expect(other).toEqual({ status: "NEW", internalNote: null });
  });

  it("Ablehnen ohne Grund liefert den Fehlertext, mit Grund wird abgelehnt", async () => {
    const noReason = await setIncomingStatusAction(idA, { action: "REJECT" });
    expect(noReason).toEqual({ ok: false, error: "Bitte einen Grund angeben (3 bis 500 Zeichen)." });
    const tooShort = await setIncomingStatusAction(idA, { action: "REJECT", reason: "ab" });
    expect(tooShort.ok).toBe(false);
    expect((await dbInternal.incomingInvoice.findFirstOrThrow({ where: { id: idA }, select: { status: true } })).status).toBe("NEW");
    const unknownAction = await setIncomingStatusAction(idA, { action: "DELETE" });
    expect(unknownAction.ok).toBe(false);
  });

  it("speichert die Notiz, der Verlauf enthaelt nur Pruefsumme statt Text", async () => {
    expect(await updateIncomingAction(idA, { internalNote: NOTE })).toEqual({ ok: true });
    const row = await dbInternal.incomingInvoice.findFirstOrThrow({ where: { id: idA }, select: { internalNote: true } });
    expect(row.internalNote).toBe(NOTE);
    const logs = await dbInternal.changeLog.findMany({ where: { orgId: orgA, entityId: idA }, select: { diffJson: true } });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.map((l) => l.diffJson).join("\n")).not.toContain(NOTE);
  });

  it("Status laeuft vorwaerts und ein Zuruecksetzen braucht einen Grund", async () => {
    expect(await setIncomingStatusAction(idA, { action: "CHECK" })).toEqual({ ok: true });
    expect(await setIncomingStatusAction(idA, { action: "APPROVE" })).toEqual({ ok: true });
    const locked = await updateIncomingAction(idA, { supplierContactId: null, manual: { supplierName: "X", number: "1", issueDate: "2026-11-01", grossCents: 1, currency: "EUR" } });
    expect(locked.ok).toBe(false);
    expect((await setIncomingStatusAction(idA, { action: "REVERT" })).ok).toBe(false);
    expect(await setIncomingStatusAction(idA, { action: "REVERT", reason: "Rueckfrage beim Lieferanten" })).toEqual({ ok: true });
  });
});

describe("Detailseite", () => {
  it("zeigt Ablauf, Lieferant, Zahlung mit GiroCode, Notiz und Verlauf; fremde Id ergibt 404", async () => {
    const html = renderToStaticMarkup(await EingangDetailPage({ params: Promise.resolve({ id: idA }) }));
    for (const s of ['aria-label="Bearbeitung"', 'aria-label="Lieferant"', 'aria-label="Zahlung"', "GiroCode über", "Interne Notiz", 'aria-label="Verlauf"', NOTE]) expect(html).toContain(s);
    await expect(EingangDetailPage({ params: Promise.resolve({ id: idB }) })).rejects.toThrow("notFound");
  });
});

describe("Druckseite", () => {
  it("zeigt Bearbeitungsstatus, aber nie die interne Notiz", async () => {
    const el = await EingangDruckPage({ params: Promise.resolve({ id: idA }) });
    const html = renderToStaticMarkup(el);
    expect(html).toMatch(/Bearbeitungsstatus: (Neu|Geprüft)/);
    expect(html).not.toContain(NOTE);
    expect(html).not.toContain("Interne Notiz");
  });
});
