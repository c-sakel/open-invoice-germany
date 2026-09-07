/**
 * Phase 11c, Task 2 — POST /api/pdf/preview: Live-Vorschau eines UNGESPEICHERTEN
 * Editor-Entwurfs (Rechnung/Geschaeftsdokument/Lieferschein), OHNE DB-Schreibzugriff.
 * Nummer "ENTWURF", Wasserzeichen "VORSCHAU" auf jeder Seite; `internalNotes` duerfen NIE
 * im gerenderten PDF landen. `?compress=0` (nur bei NODE_ENV=test) liefert ein
 * unkomprimiertes PDF, das `pdf-parse` (alte pdf.js-Version) zuverlaessig parst.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("no org");
    return {
      id: orgStore.id,
      legalName: "Preview Test GmbH",
      addressLine1: "A 1",
      addressLine2: null,
      postalCode: "1",
      city: "B",
      country: "DE",
      vatId: "DE123456789",
      taxNumber: null,
      email: null,
      phone: null,
      electronicAddress: null,
      iban: "DE02120300000000202051",
      bic: null,
      bankName: null,
      website: null,
      ownerName: null,
    };
  },
}));

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { POST as previewPost } from "@/app/api/pdf/preview/route";
import { parsePdf } from "../helpers/pdf-theme";

let orgId: string;
let customerId: string;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Preview Test GmbH", addressLine1: "A 1", postalCode: "1", city: "B", vatId: "DE123456789", taxNumber: "74/1", iban: "DE02120300000000202051" },
  });
  orgId = org.id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);
  const c = await dbInternal.customer.create({
    data: { orgId, name: "Vorschau Kunde AG", addressLine1: "K 1", postalCode: "2", city: "C", type: "BUSINESS", customerNumber: "K-74" },
  });
  customerId = c.id;
});

// `compress=0` NUR unter NODE_ENV=test wirksam (siehe Route) — macht das PDF fuer
// `pdf-parse` (buendelt eine sehr alte pdf.js-Version) zuverlaessig parsbar, unabhaengig
// davon, ob dieser Test-Prozess bereits andere PDFs geparst hat.
function req(body: unknown) {
  return new Request("http://localhost/api/pdf/preview?compress=0", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const line = { lineType: "ITEM", description: "Beratung", quantityMilli: 2000, unit: "HUR", unitNetPriceCents: 9500, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 };

describe("POST /api/pdf/preview", () => {
  it("rendert eine Rechnungsvorschau ohne DB-Schreibzugriff, mit ENTWURF und Wasserzeichen", async () => {
    const before = await dbInternal.invoice.count();
    const res = await previewPost(
      req({
        kind: "INVOICE",
        layoutId: "schlicht",
        payload: {
          customerId,
          type: "INVOICE",
          taxScheme: "REGULAR",
          currency: "EUR",
          subject: "Test",
          paymentTerms: "Zahlbar in 14 Tagen.",
          internalNotes: "GEHEIM-NOTIZ",
          lines: [line],
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { text, numpages } = await parsePdf(Buffer.from(await res.arrayBuffer()));
    expect(text).toContain("ENTWURF");
    expect(text).toContain("Vorschau Kunde AG");
    expect(text).toContain("Beratung");
    expect((text.match(/VORSCHAU/g) ?? []).length).toBeGreaterThanOrEqual(numpages);
    expect(text).not.toContain("GEHEIM");
    expect(await dbInternal.invoice.count()).toBe(before);
  });

  it("Angebot und Lieferschein rendern; 400 bei Zod-Fehler; 404 bei fremdem Kunden", async () => {
    const doc = await previewPost(req({ kind: "DOCUMENT", payload: { kind: "ANGEBOT", customerId, currency: "EUR", lines: [line] } }));
    expect(doc.status).toBe(200);
    const dn = await previewPost(req({ kind: "DELIVERY_NOTE", payload: { customerId, lines: [{ description: "Ware", quantityMilli: 3000, unit: "C62" }] } }));
    expect(dn.status).toBe(200);
    const bad = await previewPost(req({ kind: "INVOICE", payload: { customerId, lines: [] } }));
    expect(bad.status).toBe(400);
    const foreign = await previewPost(req({ kind: "INVOICE", payload: { customerId: "gibtsnicht", type: "INVOICE", currency: "EUR", lines: [line] } }));
    expect(foreign.status).toBe(404);
  });
});
