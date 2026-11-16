/**
 * Einstellungen fuer Umsatzgrenzen (§ 19 UStG) und Verzugshinweis (§ 286 Abs. 3 BGB):
 * Standardwerte, Rundlauf, Selbstheilung, Validierung und Teil-Updates ueber REST und Formular.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth/server", () => ({ getCurrentUserId: async () => "tester" }));

import { z } from "zod";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createApiKey } from "@/domain/api-key/create";
import { loadDocumentSettings, saveDocumentSettings } from "@/domain/document/settings";
import { PATCH as v1SettingsPatch } from "@/app/api/v1/Settings/route";
import { PUT as docSettingsPut } from "@/app/api/settings/documents/route";
import { saveDocumentSettingsAction } from "@/app/actions/document-settings";

let orgId: string;
let freshOrgId: string;
let adminToken: string;

beforeAll(async () => {
  const mk = async (name: string) =>
    (await dbInternal.organization.create({ data: { legalName: name, addressLine1: "Teststr. 1", postalCode: "12345", city: "Berlin" } })).id;
  orgId = await mk("Pruefungen Schema GmbH");
  freshOrgId = await mk("Pruefungen Schema Leer GmbH");
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);
  adminToken = (await createApiKey(orgId, { name: "a", scopes: ["read", "write", "admin"] })).token;
});

describe("Standardwerte", () => {
  it("neue DocumentSettings-Zeile: 80, null, {}, false", async () => {
    await dbInternal.documentSettings.create({ data: { orgId: freshOrgId } });
    const row = await dbInternal.documentSettings.findUniqueOrThrow({
      where: { orgId: freshOrgId },
      select: { kuWarnPercent: true, kuBusinessStartYear: true, kuExternalRevenueJson: true, consumerDefaultNotice: true },
    });
    expect(row).toEqual({ kuWarnPercent: 80, kuBusinessStartYear: null, kuExternalRevenueJson: "{}", consumerDefaultNotice: false });
    const s = await loadDocumentSettings(freshOrgId);
    expect(s).toMatchObject({ kuWarnPercent: 80, kuBusinessStartYear: null, kuExternalRevenue: {}, consumerDefaultNotice: false });
  });

  it("Invoice.consumerDefaultNotice ist standardmaessig NULL", async () => {
    const c = await dbInternal.customer.create({ data: { orgId: freshOrgId, name: "K", addressLine1: "W 1", postalCode: "12345", city: "B" } });
    const inv = await dbInternal.invoice.create({ data: { orgId: freshOrgId, customerId: c.id }, select: { consumerDefaultNotice: true } });
    expect(inv.consumerDefaultNotice).toBeNull();
  });
});

describe("Speichern und Laden", () => {
  it("Rundlauf der vier Felder", async () => {
    await saveDocumentSettings(orgId, {
      kuWarnPercent: 70,
      kuBusinessStartYear: 2024,
      kuExternalRevenue: { "2025": 1_234_500, "2026": 0 },
      consumerDefaultNotice: true,
    });
    const s = await loadDocumentSettings(orgId);
    expect(s).toMatchObject({ kuWarnPercent: 70, kuBusinessStartYear: 2024, kuExternalRevenue: { "2025": 1_234_500, "2026": 0 }, consumerDefaultNotice: true });
  });

  it("kaputtes kuExternalRevenueJson liefert {}", async () => {
    for (const bad of ["{kaputt", '{"25": 5}', '{"2025": -3}', "[]"]) {
      await dbInternal.documentSettings.update({ where: { orgId }, data: { kuExternalRevenueJson: bad } });
      expect((await loadDocumentSettings(orgId)).kuExternalRevenue).toEqual({});
    }
  });

  it("ungueltige Eingaben: 11 Jahre, negativer Betrag, Jahr \"25\", Schwelle 0/100, Startjahr 1999", async () => {
    const eleven = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [String(2020 + i), 1]));
    for (const bad of [
      { kuExternalRevenue: eleven },
      { kuExternalRevenue: { "2025": -1 } },
      { kuExternalRevenue: { "25": 100 } },
      { kuExternalRevenue: { "2025": 1.5 } },
      { kuWarnPercent: 0 },
      { kuWarnPercent: 100 },
      { kuBusinessStartYear: 1999 },
    ]) {
      await expect(saveDocumentSettings(orgId, bad)).rejects.toBeInstanceOf(z.ZodError);
    }
  });
});

describe("Teil-Updates setzen die Felder nicht zurueck", () => {
  async function setKnown() {
    await saveDocumentSettings(orgId, {
      kuWarnPercent: 65,
      kuBusinessStartYear: 2023,
      kuExternalRevenue: { "2024": 500_000 },
      consumerDefaultNotice: true,
    });
  }
  const expectKept = async () => {
    expect(await loadDocumentSettings(orgId)).toMatchObject({
      kuWarnPercent: 65,
      kuBusinessStartYear: 2023,
      kuExternalRevenue: { "2024": 500_000 },
      consumerDefaultNotice: true,
    });
  };

  it("PATCH /api/v1/Settings ohne die Felder", async () => {
    await setKnown();
    const res = await v1SettingsPatch(
      new Request("http://x/api/v1/Settings", {
        method: "PATCH",
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        body: JSON.stringify({ documents: { invoiceDueDays: 21 } }),
      }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(200);
    expect((await loadDocumentSettings(orgId)).invoiceDueDays).toBe(21);
    await expectKept();
  });

  it("PUT /api/settings/documents ohne die Felder", async () => {
    await setKnown();
    const res = await docSettingsPut(new Request("http://x", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ invoiceDueDays: 10 }) }));
    expect(res.status).toBe(200);
    await expectKept();
  });

  it("Formular ohne die Felder", async () => {
    await setKnown();
    const fd = new FormData();
    fd.set("invoiceDueDays", "14");
    const r = await saveDocumentSettingsAction({ ok: false }, fd);
    expect(r.ok).toBe(true);
    await expectKept();
  });

  it("PATCH mit den Feldern setzt sie", async () => {
    await setKnown();
    const res = await v1SettingsPatch(
      new Request("http://x/api/v1/Settings", {
        method: "PATCH",
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        body: JSON.stringify({ documents: { kuWarnPercent: 90, kuExternalRevenue: { "2026": 42 } } }),
      }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(200);
    expect(await loadDocumentSettings(orgId)).toMatchObject({ kuWarnPercent: 90, kuExternalRevenue: { "2026": 42 }, kuBusinessStartYear: 2023 });
  });
});
