/**
 * Oberflaeche Eingang: Server-Action "erneut pruefen" und Zaehler je Pruefstatus. Testjahr 2236 (keine Belegnummern
 * betroffen), ARCHIVE_DIR im Tempverzeichnis, Pruefmaschine aus.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));
vi.mock("@/lib/auth/server", () => ({ getCurrentUserId: async () => "tester" }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { dbInternal } from "@/lib/db";
import { resetRateLimits } from "@/lib/rate-limit";
import { receiveIncomingInvoice } from "@/domain/incoming/receive";
import { countIncomingByValidationStatus, listIncomingInvoices } from "@/domain/incoming/list";
import { revalidateIncomingAction } from "@/app/eingang/actions";

const fx = (n: string) => fs.readFileSync(path.resolve(__dirname, "../fixtures/incoming", n));

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
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "incoming-ui-"));
  prevDir = process.env.ARCHIVE_DIR;
  process.env.ARCHIVE_DIR = tmp;
  prevValidation = process.env.INCOMING_VALIDATION;
  process.env.INCOMING_VALIDATION = "off";
  orgA = await mkOrg("Eingang Oberflaeche A GmbH");
  orgB = await mkOrg("Eingang Oberflaeche B GmbH");
  const opts = { fileName: "rechnung.xml", channel: "UPLOAD" as const, actor: "tester" };
  idA = (await receiveIncomingInvoice(orgA, fx("gen-base-ubl.xml"), opts)).id;
  idB = (await receiveIncomingInvoice(orgB, fx("gen-base-ubl.xml"), opts)).id;
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

describe("Server-Action erneut pruefen", () => {
  it("prueft die eigene Eingangsrechnung und legt eine Ergebniszeile an", async () => {
    const before = await dbInternal.incomingInvoiceValidation.count({ where: { incomingInvoiceId: idA } });
    const r = await revalidateIncomingAction(idA);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(typeof r.data.result).toBe("string");
      expect(r.data.validationId === null || typeof r.data.validationId === "string").toBe(true);
    }
    const after = await dbInternal.incomingInvoiceValidation.count({ where: { incomingInvoiceId: idA } });
    expect(after - before).toBe(r.ok && r.data.validationId ? 1 : 0);
  });

  it("fremde und unbekannte Id liefern denselben Fehler, die fremde Rechnung bleibt unberuehrt", async () => {
    const before = await dbInternal.incomingInvoiceValidation.count({ where: { incomingInvoiceId: idB } });
    const foreign = await revalidateIncomingAction(idB);
    const unknown = await revalidateIncomingAction("ckunbekannt000000000000000");
    expect(foreign).toEqual({ ok: false, error: "Eingangsrechnung nicht gefunden." });
    expect(unknown).toEqual(foreign);
    expect(await dbInternal.incomingInvoiceValidation.count({ where: { incomingInvoiceId: idB } })).toBe(before);
  });

  it("lehnt ungueltige Eingaben ab", async () => {
    expect((await revalidateIncomingAction("")).ok).toBe(false);
    expect((await revalidateIncomingAction(42)).ok).toBe(false);
    expect((await revalidateIncomingAction("x".repeat(65))).ok).toBe(false);
  });

  it("begrenzt die Pruefungen je Minute und Firma", async () => {
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      const r = await revalidateIncomingAction(idA);
      if (!r.ok && r.error.includes("Zu viele")) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
  });
});

describe("Liste und Zaehler", () => {
  it("zaehlt und listet nur die eigene Organisation", async () => {
    const counts = await countIncomingByValidationStatus(orgA);
    expect(Object.values(counts).reduce((s, n) => s + n, 0)).toBe(1);
    const list = await listIncomingInvoices(orgA, { limit: 50, offset: 0 });
    expect(list.rows.map((r) => r.id)).toEqual([idA]);
    expect(list.total).toBe(1);
  });
});
