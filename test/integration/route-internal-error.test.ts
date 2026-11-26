/** S-05: 500-Antworten tragen einen festen Text, nie die Fehlermeldung (Details nur im Log). */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/org", () => ({ getActiveOrg: async () => ({ id: "org-fehler" }) }));
vi.mock("@/domain/invoice/finalize-warnings", () => ({
  collectFinalizeWarnings: async () => {
    throw new Error("Invalid prisma.invoice.findFirst() IBAN DE02120300000000202051 geheim");
  },
}));

import { POST } from "@/app/api/invoices/[id]/finalize/route";

afterEach(() => vi.restoreAllMocks());

describe("finalize-Route bei unerwartetem Fehler", () => {
  it("500 mit festem Text, ohne Fehlermeldung; Log ohne IBAN", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await POST(new Request("http://x/api/invoices/i/finalize", { method: "POST" }), { params: Promise.resolve({ id: "i" }) });
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: "Interner Fehler" });
    expect(body).not.toContain("IBAN");
    expect(JSON.stringify(log.mock.calls)).not.toContain("DE02120300000000202051");
  });
});
