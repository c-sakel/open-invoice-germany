/** Proxy umgangen und keine Sitzung: Route antwortet 401 und schreibt keinen ChangeLog mit Akteur "system". */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/server", () => ({ getCurrentUserId: async () => null }));
vi.mock("@/lib/org", () => ({ getActiveOrg: async () => ({ id: "org-ohne-sitzung" }) }));

import { dbInternal } from "@/lib/db";
import { DELETE } from "@/app/api/attachments/[id]/route";
import { POST as webhookPost } from "@/app/api/webhooks/route";

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
});
