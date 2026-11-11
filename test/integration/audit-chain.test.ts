/**
 * Phase 16a, Task 6 — Kettenpruefung im Betrieb (REST, Session-Route, MCP, Scheduler, CLI).
 * Eigenes Jahr 2097 (Invoice.number ist global @unique).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { recordPayment } from "@/domain/invoice/payment";
import { reversePayment } from "@/domain/invoice/payment-reversal";
import { runAuditJob, verifyOrgChain } from "@/domain/audit/verify-chain";
import { server } from "@/mcp/server";
import type { CreateInvoiceInput } from "@/schemas";
import { GET as ListV1 } from "@/app/api/v1/AuditChain/route";
import { POST as VerifyV1 } from "@/app/api/v1/AuditChain/verify/route";
import { POST as VerifySession, GET as ListSession } from "@/app/api/settings/audit/chain/route";

const execFileAsync = promisify(execFile);
const FIX_DATE = new Date("2097-03-01T10:00:00.000Z");
let orgId: string;
let adminToken: string;
let readToken: string;

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  orgId = (
    await dbInternal.organization.create({
      data: { legalName: "Kette GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" },
    })
  ).id;
  const customerId = (
    await dbInternal.customer.create({ data: { orgId, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" } })
  ).id;
  await ensureOrgMasterdata(dbInternal, orgId);
  adminToken = (await createApiKey(orgId, { name: "Admin", scopes: ["read", "write", "admin"] })).token;
  readToken = (await createApiKey(orgId, { name: "Read", scopes: ["read"] })).token;
  orgStore.id = orgId;
  resetRateLimits();

  const input = {
    customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR",
    documentDiscountPermille: 0, documentDiscountCents: 0, documentChargePermille: 0, documentChargeCents: 0,
    issueDate: FIX_DATE, deliveryDate: new Date("2097-02-25"),
    lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
  } as CreateInvoiceInput;
  const draft = await createDraftInvoice(orgId, input, { now: FIX_DATE });
  const fin = await finalizeInvoice(draft.id, { now: FIX_DATE });
  await recordPayment(fin.id, { amountCents: 11900, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId, actor: "test", now: FIX_DATE });
  const payment = await dbInternal.payment.findFirstOrThrow({ where: { invoiceId: fin.id } });
  await reversePayment(payment.id, { reason: "Falsch gebucht" }, { orgId, actor: "test", now: FIX_DATE });
});

function v1(method: "GET" | "POST", token?: string, body?: unknown, query = "") {
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request(`http://x/api/v1/AuditChain${method === "POST" ? "/verify" : ""}${query}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

describe("Kettenpruefung", () => {
  it("echte Org mit Zahlung und Gegenbuchung ist gueltig und wird protokolliert", async () => {
    const r = await verifyOrgChain(orgId, "UI");
    expect(r.valid).toBe(true);
    expect(r.entries).toBeGreaterThan(2);
    const rows = await dbInternal.chainVerification.findMany({ where: { orgId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ valid: true, entries: r.entries, trigger: "UI", lastHash: r.lastHash });
  });

  it("REST: verify braucht Scope admin, GET read liefert Historie; Body muss leer/strict sein", async () => {
    expect((await VerifyV1(v1("POST", readToken, {}), { params: Promise.resolve({}) })).status).toBe(403);
    const bad = await VerifyV1(v1("POST", adminToken, { x: 1 }), { params: Promise.resolve({}) });
    expect(bad.status).toBe(400);
    const ok = await VerifyV1(v1("POST", adminToken), { params: Promise.resolve({}) });
    expect(ok.status).toBe(200);
    expect((await ok.json()).data).toMatchObject({ valid: true });
    const list = await ListV1(v1("GET", readToken, undefined, "?limit=2"), { params: Promise.resolve({}) });
    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].trigger).toBe("API");
    expect((await ListV1(v1("GET", readToken, undefined, "?limit=0"), { params: Promise.resolve({}) })).status).toBe(400);
  });

  it("Session-Route und MCP-Tool pruefen die Kette der aktiven Org", async () => {
    const s = await VerifySession(new Request("http://x/api/settings/audit/chain", { method: "POST" }));
    expect(s.status).toBe(200);
    expect((await s.json()).data.valid).toBe(true);
    expect((await VerifySession(new Request("http://x/api/settings/audit/chain", { method: "POST", body: JSON.stringify({ a: 1 }) }))).status).toBe(400);
    const l = await ListSession(new Request("http://x/api/settings/audit/chain"));
    expect((await l.json()).data.length).toBeGreaterThan(0);

    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (a: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }> }> })._registeredTools;
    const res = await tools["verify_audit_chain"].handler({});
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toMatchObject({ valid: true });
    expect((await dbInternal.chainVerification.findFirstOrThrow({ where: { orgId, trigger: "MCP" } })).valid).toBe(true);
  });

  it("runAuditJob prueft je Org nur einmal innerhalb von 7 Tagen", async () => {
    await dbInternal.chainVerification.deleteMany({ where: { orgId } });
    const now = new Date();
    const first = await runAuditJob(now);
    expect(first.checked).toBeGreaterThanOrEqual(1);
    const second = await runAuditJob(now);
    expect(second.checked).toBe(0);
    expect(await dbInternal.chainVerification.count({ where: { orgId, trigger: "SCHEDULER" } })).toBe(1);
  });

  it("CLI: Exit 0 bei intakter Kette, Exit 1 mit Bruch-ID und Alarm nach Manipulation", async () => {
    const script = path.join(process.cwd(), "scripts", "verify-chain.ts");
    const run = () =>
      execFileAsync("npx", ["tsx", script, "--org", orgId], { env: { ...process.env, DATABASE_URL: "file:./test.db" }, cwd: process.cwd() }).then(
        (r) => ({ code: 0, out: r.stdout }),
        (e: { code?: number; stdout?: string }) => ({ code: e.code ?? -1, out: e.stdout ?? "" }),
      );
    const okRun = await run();
    expect(okRun.code).toBe(0);
    expect(okRun.out).toMatch(new RegExp(`^OK ${orgId} \\d+`, "m"));

    const victim = await dbInternal.changeLog.findFirstOrThrow({ where: { orgId }, orderBy: { id: "asc" }, skip: 1, select: { id: true } });
    await dbInternal.changeLog.update({ where: { id: victim.id }, data: { diffJson: '{"manipuliert":true}' } });
    const bad = await run();
    expect(bad.code).toBe(1);
    expect(bad.out).toContain(`FEHLER ${orgId} broken=${victim.id}`);
    expect((await dbInternal.chainVerification.findFirstOrThrow({ where: { orgId, trigger: "CLI" } })).valid).toBe(true);
  }, 120_000);

  it("manipulierter Eintrag: invalid und Pflicht-Alarm CHAIN_BROKEN", async () => {
    const r = await verifyOrgChain(orgId, "API");
    expect(r.valid).toBe(false);
    expect(r.brokenEntryId).not.toBeNull();
    const n = await dbInternal.notification.findFirst({ where: { orgId, type: "CHAIN_BROKEN" } });
    expect(n).not.toBeNull();
    expect((await dbInternal.chainVerification.findFirstOrThrow({ where: { orgId }, orderBy: { checkedAt: "desc" } })).valid).toBe(false);
  });

  it("Org-Isolation: kaputte Kette einer fremden Org beeinflusst die eigene Pruefung nicht", async () => {
    const other = (
      await dbInternal.organization.create({
        data: { legalName: "Fremd-Kette GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" },
      })
    ).id;
    await dbInternal.customer.create({ data: { orgId: other, name: "Fremd AG", addressLine1: "Weg 1", postalCode: "20095", city: "Hamburg", type: "BUSINESS" } });
    await dbInternal.changeLog.create({ data: { orgId: other, entity: "X", entityId: "1", action: "CREATE", actor: "t", at: FIX_DATE, diffJson: "{}", prevHash: "", hash: "kaputt" } });
    expect((await verifyOrgChain(other, "API")).valid).toBe(false);
    const third = (
      await dbInternal.organization.create({
        data: { legalName: "Sauber GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" },
      })
    ).id;
    const r = await verifyOrgChain(third, "API");
    expect(r).toMatchObject({ valid: true, entries: 0 });
    expect(await dbInternal.notification.count({ where: { orgId: third, type: "CHAIN_BROKEN" } })).toBe(0);
  });

  it("runAuditJob: Fehler bei einer Org stoppt die uebrigen nicht", async () => {
    const orgs = await dbInternal.organization.findMany({ select: { id: true }, orderBy: { id: "asc" } });
    await dbInternal.chainVerification.deleteMany({});
    const real = dbInternal.chainVerification.create.bind(dbInternal.chainVerification);
    const failFor = orgs[0].id;
    const spy = vi.spyOn(dbInternal.chainVerification, "create").mockImplementation(((args: { data: { orgId: string } }) => {
      if (args.data.orgId === failFor) throw new Error("simuliert");
      return real(args as never);
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await runAuditJob(new Date());
      expect(res.checked).toBe(orgs.length - 1);
      expect(await dbInternal.chainVerification.count({ where: { orgId: failFor } })).toBe(0);
      expect(await dbInternal.chainVerification.count()).toBe(orgs.length - 1);
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
