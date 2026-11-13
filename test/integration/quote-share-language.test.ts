/**
 * Task 8 (Phase 17c): oeffentliche Angebotsseite in der Belegsprache.
 * Testjahr 2154, Nummernkreis-Praefix C17T8- (QUOTE).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { updateNumberRange } from "@/domain/numbering/ranges";
import { createBusinessDocument } from "@/domain/document/create";
import { createShareLink } from "@/domain/quote-share/link";
import { decideOffer } from "@/domain/quote-share/decide";
import { resetRateLimits } from "@/lib/rate-limit";
import AngebotPage from "@/app/angebot/[token]/page";
import { decideOfferAction } from "@/app/angebot/[token]/actions";

const NOW = new Date("2154-03-01T10:00:00.000Z");
const line = { description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 123456, taxRate: 19 as const, taxCategory: "S" as const, discountPermille: 0 };

let orgId: string;
let customerId: string;

async function shareToken(language: "de" | "en" | undefined): Promise<string> {
  const q = await createBusinessDocument(
    orgId,
    { kind: "ANGEBOT", customerId, taxScheme: "REGULAR", currency: "EUR", lines: [line], validUntil: new Date("2154-04-15T00:00:00.000Z"), ...(language ? { language } : {}) },
    { now: NOW },
  );
  return (await createShareLink(orgId, q.id, {}, { now: NOW })).token;
}

async function render(token: string): Promise<string> {
  return renderToStaticMarkup(await AngebotPage({ params: Promise.resolve({ token }) }));
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  const org = await dbInternal.organization.create({
    data: { legalName: "Sprache Angebot GmbH", addressLine1: "Sprachweg 1", postalCode: "21339", city: "Lüneburg", vatId: "DE215400001", taxNumber: "21/540/00001" },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  await updateNumberRange(orgId, "ANGEBOT", { pattern: "{PREFIX}{YYYY}-{SEQ}", prefix: "C17T8-", seqPadding: 4, yearlyReset: true, nextValue: 1 }, "test", NOW);
  customerId = (await dbInternal.customer.create({ data: { orgId, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" } })).id;
});

describe("Angebotsseite je Belegsprache", () => {
  it("englisches Angebot: englische Texte, dd/mm/yyyy, en-GB-Betraege, lang=en", async () => {
    const html = await render(await shareToken("en"));
    expect(html).toContain('lang="en"');
    expect(html).toContain("Download PDF");
    expect(html).toContain("Valid until");
    expect(html).toContain("Accept quote");
    expect(html).toContain("15/04/2154");
    expect(html).toContain("1,234.56");
    expect(html).not.toContain("PDF herunterladen");
  });

  it("deutsches Angebot bleibt unveraendert", async () => {
    for (const lang of ["de", undefined] as const) {
      const html = await render(await shareToken(lang));
      expect(html).toContain('lang="de"');
      expect(html).toContain("PDF herunterladen");
      expect(html).toContain("Gültig bis");
      expect(html).toContain("Angebot annehmen");
      expect(html).toContain("15.04.2154");
      expect(html).toContain("1.234,56");
    }
  });

  it("entschiedener Link auf Englisch: Thank you", async () => {
    const token = await shareToken("en");
    await decideOffer(token, { decision: "ACCEPTED", name: "Erika Muster" }, { now: NOW });
    const html = await render(token);
    expect(html).toContain("Thank you, your quotation was accepted on");
    expect(html).toContain("No further decision");
  });
});

describe("decideOfferAction Sprache", () => {
  const prev = { ok: false } as const;

  it("lang=en und leerer Name -> englische Meldung", async () => {
    resetRateLimits();
    const token = await shareToken("en");
    const r = await decideOfferAction(token, prev, form({ lang: "en", decision: "ACCEPTED", name: "" }));
    expect(r).toEqual({ ok: false, error: "Please enter your name." });
  });

  it("lang=xx faellt auf Deutsch zurueck", async () => {
    resetRateLimits();
    const token = await shareToken("en");
    const r = await decideOfferAction(token, prev, form({ lang: "xx", decision: "ACCEPTED", name: "" }));
    expect(r).toEqual({ ok: false, error: "Bitte geben Sie Ihren Namen an." });
  });

  it("Sprache aendert die Entscheidung nicht", async () => {
    resetRateLimits();
    const token = await shareToken("en");
    const r = await decideOfferAction(token, prev, form({ lang: "de", decision: "REJECTED", name: "Erika Muster", email: "" }));
    expect(r).toEqual({ ok: true });
    const link = await dbInternal.quoteShareLink.findFirstOrThrow({ where: { orgId }, orderBy: { createdAt: "desc" }, select: { decision: true } });
    expect(link.decision).toBe("REJECTED");
  });
});
