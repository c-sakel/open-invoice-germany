/** Proxy umgangen und keine Sitzung: Route antwortet 401 und schreibt keinen ChangeLog mit Akteur "system". */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/server", () => ({ getCurrentUserId: async () => null }));
vi.mock("@/lib/org", () => ({ getActiveOrg: async () => ({ id: "org-ohne-sitzung" }) }));

import { dbInternal } from "@/lib/db";
import { DELETE } from "@/app/api/attachments/[id]/route";
import { POST as webhookPost } from "@/app/api/webhooks/route";
import { POST as apiKeyPost } from "@/app/api/api-keys/route";
import { POST as finalizePost } from "@/app/api/invoices/[id]/finalize/route";
import { POST as paymentPost } from "@/app/api/invoices/[id]/payment/route";

describe("API-Routen ohne Sitzung", () => {
  it("DELETE /api/attachments/[id] -> 401, kein ChangeLog von system", async () => {
    const before = await dbInternal.changeLog.count({ where: { actor: "system" } });
    const res = await DELETE(new Request("http://x/api/attachments/a", { method: "DELETE" }), { params: Promise.resolve({ id: "a" }) });
    expect(res.status).toBe(401);
    expect(await dbInternal.changeLog.count({ where: { actor: "system" } })).toBe(before);
  });

  it("POST /api/webhooks -> 401", async () => {
    const res = await webhookPost(new Request("http://x/api/webhooks", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
  });

  it("POST /api/api-keys -> 401, kein Schluessel angelegt", async () => {
    const before = await dbInternal.apiKey.count();
    const res = await apiKeyPost(new Request("http://x/api/api-keys", { method: "POST", body: JSON.stringify({ name: "x" }) }));
    expect(res.status).toBe(401);
    expect(await dbInternal.apiKey.count()).toBe(before);
  });

  it("POST finalize/payment -> 401", async () => {
    const ctx = { params: Promise.resolve({ id: "i" }) };
    expect((await finalizePost(new Request("http://x", { method: "POST" }), ctx)).status).toBe(401);
    expect((await paymentPost(new Request("http://x", { method: "POST", body: "{}" }), ctx)).status).toBe(401);
  });
});
