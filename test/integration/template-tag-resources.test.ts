/**
 * Phase 13d, Task 5 — Integrationstests fuer `/api/v1/Tag` und `/api/v1/DocumentTemplate`
 * (task-5-brief.md, Muster test/integration/api-resources.test.ts: Route-Handler direkt
 * aufgerufen, kein echter HTTP-Server). Testjahr nicht relevant (Rechnungen bleiben
 * DRAFT — kein finalizeInvoice, kein NumberRange-Verbrauch, siehe api-resources.test.ts-
 * Kommentar).
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";

import { POST as InvoiceCreate } from "@/app/api/v1/Invoice/route";
import { GET as TagList, POST as TagCreate } from "@/app/api/v1/Tag/route";
import { GET as TagGet, PATCH as TagUpdate, DELETE as TagDelete } from "@/app/api/v1/Tag/[id]/route";
import { POST as TagAssign } from "@/app/api/v1/Tag/[id]/assign/route";
import { POST as TagUnassign } from "@/app/api/v1/Tag/[id]/unassign/route";
import { GET as TemplateList, POST as TemplateCreate } from "@/app/api/v1/DocumentTemplate/route";
import { GET as TemplateGet, PATCH as TemplateUpdate, DELETE as TemplateDelete } from "@/app/api/v1/DocumentTemplate/[id]/route";
import { POST as TemplateApply } from "@/app/api/v1/DocumentTemplate/[id]/apply/route";

let orgId: string;
let otherOrgId: string;
let customerId: string;
let otherCustomerId: string;
let token: string;
let readOnlyToken: string;
let otherToken: string;

function req(url: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const headers = new Headers();
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return new Request(url, { method: opts.method ?? "GET", headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
}

function ctxFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function json(res: Response) {
  return res.json();
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Vorlagen-Tags Test GmbH", addressLine1: "Teststr. 5", postalCode: "10117", city: "Berlin", vatId: "DE333333333", taxNumber: "33/333/33333" },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);

  const other = await dbInternal.organization.create({
    data: { legalName: "Fremde Vorlagen-Org GmbH", addressLine1: "X-Str. 2", postalCode: "1", city: "X" },
  });
  otherOrgId = other.id;
  await ensureOrgMasterdata(dbInternal, otherOrgId);

  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Wartungskunde AG", addressLine1: "Marktplatz 9", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  });
  customerId = customer.id;

  // Review-Fund Task 6: Kunde einer FREMDEN Organisation — createTemplate/updateTemplate/
  // applyTemplate duerfen eine solche id nie stillschweigend akzeptieren.
  const otherCustomer = await dbInternal.customer.create({
    data: { orgId: otherOrgId, name: "Fremdkunde AG", addressLine1: "Y-Str. 1", postalCode: "2", city: "Y", type: "BUSINESS" },
  });
  otherCustomerId = otherCustomer.id;

  const key = await createApiKey(orgId, { name: "Vorlagen-Tags-Key", scopes: ["read", "write"] });
  token = key.token;
  const readKey = await createApiKey(orgId, { name: "Vorlagen-Tags-Read-Key", scopes: ["read"] });
  readOnlyToken = readKey.token;
  const otherKey = await createApiKey(otherOrgId, { name: "Fremd-Key", scopes: ["read", "write"] });
  otherToken = otherKey.token;
  resetRateLimits();
});

beforeEach(() => {
  resetRateLimits();
});

async function createInvoice() {
  const res = await InvoiceCreate(
    req("http://x/api/v1/Invoice", { method: "POST", token, body: { customerId, lines: [{ description: "Pos 1", quantityMilli: 1000, unitNetPriceCents: 10000, taxRate: 19 }] } }),
  );
  expect(res.status).toBe(201);
  return (await json(res)).data;
}

// ── Tag ───────────────────────────────────────────────────────────────────────
describe("/api/v1/Tag", () => {
  it("ohne Token -> 401", async () => {
    const res = await TagList(req("http://x/api/v1/Tag"));
    expect(res.status).toBe(401);
  });

  it("Create mit read-Scope -> 403 FORBIDDEN", async () => {
    const res = await TagCreate(req("http://x/api/v1/Tag", { method: "POST", token: readOnlyToken, body: { name: "Verboten" } }));
    expect(res.status).toBe(403);
  });

  it("Create ohne name -> 400 VALIDATION", async () => {
    const res = await TagCreate(req("http://x/api/v1/Tag", { method: "POST", token, body: { color: "emerald" } }));
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("VALIDATION");
  });

  it("Round-Trip: anlegen -> zuordnen -> lesen -> entfernen -> loeschen", async () => {
    const inv = await createInvoice();

    const created = await TagCreate(req("http://x/api/v1/Tag", { method: "POST", token, body: { name: "Wartung", color: "emerald" } }));
    expect(created.status).toBe(201);
    const tag = (await json(created)).data;
    expect(tag.objectName).toBe("Tag");
    expect(tag.documentCount).toBe(0);

    const ref = { docType: "INVOICE", docId: inv.id };
    const assignRes = await TagAssign(req(`http://x/api/v1/Tag/${tag.id}/assign`, { method: "POST", token, body: ref }), ctxFor(tag.id));
    expect(assignRes.status).toBe(200);
    expect((await json(assignRes)).data.created).toBe(true);

    // Zweiter Aufruf ist idempotent (kein Fehler, `created: false`).
    const assignAgain = await TagAssign(req(`http://x/api/v1/Tag/${tag.id}/assign`, { method: "POST", token, body: ref }), ctxFor(tag.id));
    expect(assignAgain.status).toBe(200);
    expect((await json(assignAgain)).data.created).toBe(false);

    const getRes = await TagGet(req(`http://x/api/v1/Tag/${tag.id}`, { token }), ctxFor(tag.id));
    expect(getRes.status).toBe(200);
    const getBody = await json(getRes);
    expect(getBody.data.objectName).toBe("Tag");
    expect(getBody.data.documentCount).toBe(1);

    const unassignRes = await TagUnassign(req(`http://x/api/v1/Tag/${tag.id}/unassign`, { method: "POST", token, body: ref }), ctxFor(tag.id));
    expect(unassignRes.status).toBe(200);
    expect((await json(unassignRes)).data.removed).toBe(true);

    // Zweiter Aufruf ist idempotent (keine Zuordnung mehr da, `removed: false`).
    const unassignAgain = await TagUnassign(req(`http://x/api/v1/Tag/${tag.id}/unassign`, { method: "POST", token, body: ref }), ctxFor(tag.id));
    expect(unassignAgain.status).toBe(200);
    expect((await json(unassignAgain)).data.removed).toBe(false);

    const delRes = await TagDelete(req(`http://x/api/v1/Tag/${tag.id}`, { method: "DELETE", token }), ctxFor(tag.id));
    expect(delRes.status).toBe(200);
    expect((await json(delRes)).data.deleted).toBe(true);

    const getAfterDelete = await TagGet(req(`http://x/api/v1/Tag/${tag.id}`, { token }), ctxFor(tag.id));
    expect(getAfterDelete.status).toBe(404);
  });

  it("Zuordnen zu unbekanntem Beleg -> 404", async () => {
    const created = await TagCreate(req("http://x/api/v1/Tag", { method: "POST", token, body: { name: "Ohne-Beleg" } }));
    const tag = (await json(created)).data;
    const res = await TagAssign(
      req(`http://x/api/v1/Tag/${tag.id}/assign`, { method: "POST", token, body: { docType: "INVOICE", docId: "unbekannt" } }),
      ctxFor(tag.id),
    );
    expect(res.status).toBe(404);
  });

  it("Zuordnen mit unbekanntem Tag -> 404", async () => {
    const inv = await createInvoice();
    const res = await TagAssign(
      req("http://x/api/v1/Tag/unbekannt/assign", { method: "POST", token, body: { docType: "INVOICE", docId: inv.id } }),
      ctxFor("unbekannt"),
    );
    expect(res.status).toBe(404);
  });

  it("Create mit doppeltem Namen -> 409 CONFLICT", async () => {
    const first = await TagCreate(req("http://x/api/v1/Tag", { method: "POST", token, body: { name: "Doppelt" } }));
    expect(first.status).toBe(201);
    const second = await TagCreate(req("http://x/api/v1/Tag", { method: "POST", token, body: { name: "Doppelt" } }));
    expect(second.status).toBe(409);
    expect((await json(second)).error.code).toBe("CONFLICT");
  });

  it("Update (Umbenennen) -> 200", async () => {
    const created = await TagCreate(req("http://x/api/v1/Tag", { method: "POST", token, body: { name: "Vorher" } }));
    const tag = (await json(created)).data;
    const res = await TagUpdate(req(`http://x/api/v1/Tag/${tag.id}`, { method: "PATCH", token, body: { name: "Nachher", color: "sky" } }), ctxFor(tag.id));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.name).toBe("Nachher");
    expect(body.data.color).toBe("sky");
  });

  it("Liste: Paginierung", async () => {
    const res = await TagList(req("http://x/api/v1/Tag?limit=1&offset=0", { token }));
    expect(res.status).toBe(200);
    const j = await json(res);
    expect(j.limit).toBe(1);
    expect(j.data.length).toBeLessThanOrEqual(1);
    expect(j.total).toBeGreaterThan(0);
  });

  it("Get/Update/Delete fremder Org -> 404", async () => {
    const created = await TagCreate(req("http://x/api/v1/Tag", { method: "POST", token, body: { name: "Fremd-Test" } }));
    const tag = (await json(created)).data;
    const getRes = await TagGet(req(`http://x/api/v1/Tag/${tag.id}`, { token: otherToken }), ctxFor(tag.id));
    expect(getRes.status).toBe(404);
    const updRes = await TagUpdate(req(`http://x/api/v1/Tag/${tag.id}`, { method: "PATCH", token: otherToken, body: { name: "x" } }), ctxFor(tag.id));
    expect(updRes.status).toBe(404);
    const delRes = await TagDelete(req(`http://x/api/v1/Tag/${tag.id}`, { method: "DELETE", token: otherToken }), ctxFor(tag.id));
    expect(delRes.status).toBe(404);
  });
});

// ── DocumentTemplate ─────────────────────────────────────────────────────────
describe("/api/v1/DocumentTemplate", () => {
  it("ohne Token -> 401", async () => {
    const res = await TemplateList(req("http://x/api/v1/DocumentTemplate"));
    expect(res.status).toBe(401);
  });

  it("Create mit read-Scope -> 403 FORBIDDEN", async () => {
    const res = await TemplateCreate(req("http://x/api/v1/DocumentTemplate", { method: "POST", token: readOnlyToken, body: { name: "x", docType: "INVOICE", payload: { lines: [] } } }));
    expect(res.status).toBe(403);
  });

  it("Create ohne Zeilen -> 400 VALIDATION", async () => {
    const res = await TemplateCreate(
      req("http://x/api/v1/DocumentTemplate", { method: "POST", token, body: { name: "Leer", docType: "INVOICE", payload: { lines: [] } } }),
    );
    expect(res.status).toBe(400);
  });

  it("Round-Trip: anlegen -> lesen -> aktualisieren -> anwenden -> loeschen", async () => {
    const created = await TemplateCreate(
      req("http://x/api/v1/DocumentTemplate", {
        method: "POST",
        token,
        body: {
          name: "Standard-Wartung",
          docType: "INVOICE",
          customerId,
          payload: { lines: [{ description: "Wartung", quantityMilli: 1000, unitNetPriceCents: 5000, taxRate: 19 }] },
        },
      }),
    );
    expect(created.status).toBe(201);
    const tpl = (await json(created)).data;
    expect(tpl.objectName).toBe("DocumentTemplate");
    expect(tpl.payload.lines).toHaveLength(1);

    const getRes = await TemplateGet(req(`http://x/api/v1/DocumentTemplate/${tpl.id}`, { token }), ctxFor(tpl.id));
    expect(getRes.status).toBe(200);

    const updRes = await TemplateUpdate(
      req(`http://x/api/v1/DocumentTemplate/${tpl.id}`, {
        method: "PATCH",
        token,
        body: { name: "Erweiterte Wartung", payload: { lines: [{ description: "Wartung Plus", quantityMilli: 2000, unitNetPriceCents: 6000, taxRate: 19 }] } },
      }),
      ctxFor(tpl.id),
    );
    expect(updRes.status).toBe(200);
    const updBody = await json(updRes);
    expect(updBody.data.name).toBe("Erweiterte Wartung");
    expect(updBody.data.payload.lines[0].description).toBe("Wartung Plus");

    const applyRes = await TemplateApply(req(`http://x/api/v1/DocumentTemplate/${tpl.id}/apply`, { method: "POST", token, body: {} }), ctxFor(tpl.id));
    expect(applyRes.status).toBe(201);
    const applyBody = (await json(applyRes)).data;
    expect(applyBody).toMatchObject({ objectName: "DocumentTemplateApplication", docType: "INVOICE" });
    expect(applyBody.id).toBeTruthy();

    const delRes = await TemplateDelete(req(`http://x/api/v1/DocumentTemplate/${tpl.id}`, { method: "DELETE", token }), ctxFor(tpl.id));
    expect(delRes.status).toBe(200);
    expect((await json(delRes)).data.deleted).toBe(true);

    const getAfterDelete = await TemplateGet(req(`http://x/api/v1/DocumentTemplate/${tpl.id}`, { token }), ctxFor(tpl.id));
    expect(getAfterDelete.status).toBe(404);
  });

  it("Anwenden ohne Kunde (Vorlage + Payload ohne customerId) -> 409 CONFLICT", async () => {
    const created = await TemplateCreate(
      req("http://x/api/v1/DocumentTemplate", {
        method: "POST",
        token,
        body: { name: "Ohne Kunde", docType: "INVOICE", payload: { lines: [{ description: "Pos", quantityMilli: 1000, unitNetPriceCents: 1000, taxRate: 19 }] } },
      }),
    );
    const tpl = (await json(created)).data;
    const res = await TemplateApply(req(`http://x/api/v1/DocumentTemplate/${tpl.id}/apply`, { method: "POST", token, body: {} }), ctxFor(tpl.id));
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("CONFLICT");
  });

  it("Create mit doppeltem Namen -> 409 CONFLICT", async () => {
    const body = { name: "Doppelte Vorlage", docType: "INVOICE" as const, payload: { lines: [{ description: "Pos", quantityMilli: 1000, unitNetPriceCents: 1000, taxRate: 19 }] } };
    const first = await TemplateCreate(req("http://x/api/v1/DocumentTemplate", { method: "POST", token, body }));
    expect(first.status).toBe(201);
    const second = await TemplateCreate(req("http://x/api/v1/DocumentTemplate", { method: "POST", token, body }));
    expect(second.status).toBe(409);
  });

  it("Liste: Paginierung + Filter docType", async () => {
    const res = await TemplateList(req("http://x/api/v1/DocumentTemplate?docType=INVOICE&limit=1&offset=0", { token }));
    expect(res.status).toBe(200);
    const j = await json(res);
    expect(j.limit).toBe(1);
    expect(j.data.length).toBeLessThanOrEqual(1);
    if (j.data[0]) expect(j.data[0].docType).toBe("INVOICE");
  });

  it("Get/Update/Delete fremder Org -> 404", async () => {
    const created = await TemplateCreate(
      req("http://x/api/v1/DocumentTemplate", {
        method: "POST",
        token,
        body: { name: "Fremd-Vorlage-Test", docType: "INVOICE", payload: { lines: [{ description: "Pos", quantityMilli: 1000, unitNetPriceCents: 1000, taxRate: 19 }] } },
      }),
    );
    const tpl = (await json(created)).data;
    const getRes = await TemplateGet(req(`http://x/api/v1/DocumentTemplate/${tpl.id}`, { token: otherToken }), ctxFor(tpl.id));
    expect(getRes.status).toBe(404);
    const updRes = await TemplateUpdate(req(`http://x/api/v1/DocumentTemplate/${tpl.id}`, { method: "PATCH", token: otherToken, body: { name: "x" } }), ctxFor(tpl.id));
    expect(updRes.status).toBe(404);
    const delRes = await TemplateDelete(req(`http://x/api/v1/DocumentTemplate/${tpl.id}`, { method: "DELETE", token: otherToken }), ctxFor(tpl.id));
    expect(delRes.status).toBe(404);
  });

  it("Anwenden einer unbekannten Vorlage -> 404", async () => {
    const res = await TemplateApply(req("http://x/api/v1/DocumentTemplate/unbekannt/apply", { method: "POST", token, body: {} }), ctxFor("unbekannt"));
    expect(res.status).toBe(404);
  });

  // Review-Fund Task 6 (Befund zu Task 5): customerId muss gegen die eigene Organisation
  // geprueft werden — sonst koennte eine fremde Kunden-Id unbemerkt in einer Vorlage
  // landen (createTemplate) bzw. eine bestehende Vorlage auf einen fremden Kunden
  // umgehaengt werden (updateTemplate).
  it("Create mit Kunde einer fremden Organisation -> 404", async () => {
    const res = await TemplateCreate(
      req("http://x/api/v1/DocumentTemplate", {
        method: "POST",
        token,
        body: {
          name: "Fremdkunden-Vorlage",
          docType: "INVOICE",
          customerId: otherCustomerId,
          payload: { lines: [{ description: "Pos", quantityMilli: 1000, unitNetPriceCents: 1000, taxRate: 19 }] },
        },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("Update mit Kunde einer fremden Organisation -> 404", async () => {
    const created = await TemplateCreate(
      req("http://x/api/v1/DocumentTemplate", {
        method: "POST",
        token,
        body: { name: "Umzuhaengende Vorlage", docType: "INVOICE", payload: { lines: [{ description: "Pos", quantityMilli: 1000, unitNetPriceCents: 1000, taxRate: 19 }] } },
      }),
    );
    const tpl = (await json(created)).data;
    const res = await TemplateUpdate(req(`http://x/api/v1/DocumentTemplate/${tpl.id}`, { method: "PATCH", token, body: { customerId: otherCustomerId } }), ctxFor(tpl.id));
    expect(res.status).toBe(404);
  });

  // Review-Fund Task 6: applyTemplate ruft createDraftInvoice/createBusinessDocument mit
  // dem angegebenen `customerId` (Override) auf — ein ungueltiger/fremder Kunde muss dort
  // (jetzt NotFoundError statt generischem Error) 404 liefern, nicht 500.
  it("Anwenden mit ungueltigem Kunden -> 404", async () => {
    const created = await TemplateCreate(
      req("http://x/api/v1/DocumentTemplate", {
        method: "POST",
        token,
        body: { name: "Vorlage fuer ungueltigen Kunden", docType: "INVOICE", payload: { lines: [{ description: "Pos", quantityMilli: 1000, unitNetPriceCents: 1000, taxRate: 19 }] } },
      }),
    );
    const tpl = (await json(created)).data;
    const res = await TemplateApply(req(`http://x/api/v1/DocumentTemplate/${tpl.id}/apply`, { method: "POST", token, body: { customerId: "unbekannt" } }), ctxFor(tpl.id));
    expect(res.status).toBe(404);
  });
});
