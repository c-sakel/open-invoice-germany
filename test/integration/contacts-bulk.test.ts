/**
 * Phase 18d, Task 6 — Sammelanlage von Kunden: Domain, REST, MCP. Jahr 2190 (Nummernkreis), Praefix D18D6K-.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));
vi.mock("@/lib/auth/server", () => ({ getCurrentUserId: async () => "user-test" }));

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { updateNumberRange } from "@/domain/numbering/ranges";
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits, RateLimitError } from "@/lib/rate-limit";
import { createContactsBulk, ContactsBulkRejectedError, CONTACTS_BULK_MAX } from "@/domain/import/contacts-bulk";
import { server } from "@/mcp/server";
import { POST as bulkPost } from "@/app/api/v1/Contact/bulk/route";
import { ZodError } from "zod";

const RANGE_NOW = new Date("2190-01-01T10:00:00Z");
const CTX = { actor: "test", source: "API" as const };
const base = (n: number, extra: Record<string, unknown> = {}) => ({
  name: `Bulk Kunde ${n} GmbH`,
  addressLine1: "Weg 1",
  postalCode: "10115",
  city: "Berlin",
  ...extra,
});

let orgId: string;
let otherOrgId: string;
let writeToken: string;
let readToken: string;

async function makeOrg(name: string, prefix: string): Promise<string> {
  const org = await dbInternal.organization.create({
    data: { legalName: name, addressLine1: "Weg 1", postalCode: "10115", city: "Berlin", vatId: "DE219000001", taxNumber: "21/190/00001" },
  });
  await ensureOrgMasterdata(dbInternal, org.id);
  await updateNumberRange(org.id, "CUSTOMER", { pattern: "{PREFIX}{SEQ}", prefix, seqPadding: 3, yearlyReset: false, nextValue: 1 }, "test", RANGE_NOW);
  return org.id;
}
const rangeValue = async (id: string) =>
  (await dbInternal.numberRange.findFirst({ where: { orgId: id, docType: "CUSTOMER", isActive: true }, select: { currentValue: true } }))?.currentValue ?? 0;
const count = (id = orgId) => dbInternal.customer.count({ where: { orgId: id } });

beforeAll(async () => {
  orgId = await makeOrg("Bulk Kontakte GmbH", "D18D6K-");
  otherOrgId = await makeOrg("Bulk Fremd GmbH", "D18D6F-");
  orgStore.id = orgId;
  writeToken = (await createApiKey(orgId, { name: "Bulk-Schreiber", scopes: ["write"], expiresAt: null })).token;
  readToken = (await createApiKey(orgId, { name: "Bulk-Leser", scopes: ["read"], expiresAt: null })).token;
});
beforeEach(() => resetRateLimits());

describe("createContactsBulk — Domain", () => {
  it("legt Kunden in Eingabereihenfolge mit fortlaufenden Nummern an; explizite Nummer bleibt", async () => {
    const org = await makeOrg("Bulk Reihenfolge GmbH", "D18D6K-");
    const res = await createContactsBulk(org, { contacts: [base(1), base(2, { customerNumber: "EXPL-1" }), base(3)] }, CTX);
    expect(res.map((c) => c.name)).toEqual(["Bulk Kunde 1 GmbH", "Bulk Kunde 2 GmbH", "Bulk Kunde 3 GmbH"]);
    expect(res.map((c) => c.customerNumber)).toEqual(["D18D6K-001", "EXPL-1", "D18D6K-002"]);
    expect(res.every((c) => c.orgId === org)).toBe(true);
  });

  it("100 ok, 101 -> ZodError", async () => {
    const org = await makeOrg("Bulk Grenze GmbH", "D18D6G-");
    const hundred = Array.from({ length: CONTACTS_BULK_MAX }, (_, i) => base(i));
    expect(await createContactsBulk(org, { contacts: hundred }, CTX)).toHaveLength(100);
    await expect(createContactsBulk(org, { contacts: [...hundred, base(101)] }, CTX)).rejects.toBeInstanceOf(ZodError);
    expect(await count(org)).toBe(100);
  });

  it("ungueltige E-Mail -> alles oder nichts, Nummernkreis unveraendert, Meldung ohne Werte", async () => {
    const org = await makeOrg("Bulk Fehler GmbH", "D18D6H-");
    const before = await rangeValue(org);
    const err = await createContactsBulk(org, { contacts: [base(1), base(2, { email: "kein-at" })] }, CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContactsBulkRejectedError);
    const e = err as ContactsBulkRejectedError;
    expect(e.errors[0]).toEqual({ index: 1, field: "email", message: "Ungültige E-Mail-Adresse" });
    expect(await count(org)).toBe(0);
    expect(await rangeValue(org)).toBe(before);
    const text = JSON.stringify(e.errors) + e.message;
    expect(text).not.toContain("Bulk Kunde");
    expect(text).not.toContain("kein-at");
  });

  it("Duplikate: archivierter Bestand, doppelt im Request, E-Mail+Name in anderer Schreibweise", async () => {
    const org = await makeOrg("Bulk Duplikat GmbH", "D18D6D-");
    await dbInternal.customer.create({
      data: { orgId: org, name: "Alt GmbH", addressLine1: "Weg 1", postalCode: "10115", city: "Berlin", customerNumber: "ALT-1", isArchived: true, email: "alt@example.org", type: "BUSINESS", countryCode: "DE" },
    });
    const err = (await createContactsBulk(
      org,
      {
        contacts: [
          base(1, { customerNumber: "ALT-1" }),
          base(2, { customerNumber: "NEU-1" }),
          base(3, { customerNumber: "NEU-1" }),
          base(4, { name: "ALT gmbh", email: "ALT@example.org" }),
          base(5, { name: "Zwei GmbH", email: "z@example.org" }),
          base(6, { name: "ZWEI GmbH", email: "Z@example.org" }),
        ],
      },
      CTX,
    ).catch((e: unknown) => e)) as ContactsBulkRejectedError;
    expect(err.errors).toEqual([
      { index: 0, field: "customerNumber", message: "Kundennummer bereits vergeben" },
      { index: 2, field: "customerNumber", message: "Kundennummer doppelt in Eintrag 1" },
      { index: 3, field: "email", message: "Kunde mit gleicher E-Mail und gleichem Namen vorhanden" },
      { index: 5, field: "email", message: "Kunde mit gleicher E-Mail und gleichem Namen doppelt in Eintrag 4" },
    ]);
    expect(await count(org)).toBe(1);
  });

  it("orgId/id im Datensatz werden ignoriert; Zahlungsmethode fremder Org abgelehnt; Steuerzeichen abgelehnt", async () => {
    const org = await makeOrg("Bulk Org GmbH", "D18D6O-");
    const [c] = await createContactsBulk(org, { contacts: [base(1, { orgId: otherOrgId, id: "fremd-id" })] }, CTX);
    expect(c!.orgId).toBe(org);
    expect(c!.id).not.toBe("fremd-id");
    const foreign = await dbInternal.paymentMethod.findFirstOrThrow({ where: { orgId: otherOrgId }, select: { id: true } });
    const e1 = (await createContactsBulk(org, { contacts: [base(2, { defaultPaymentMethodId: foreign.id })] }, CTX).catch((e: unknown) => e)) as ContactsBulkRejectedError;
    expect(e1.errors).toEqual([{ index: 0, field: "defaultPaymentMethodId", message: "Zahlungsmethode nicht gefunden." }]);
    const e2 = (await createContactsBulk(org, { contacts: [base(3, { notes: "a\u0000b" })] }, CTX).catch((e: unknown) => e)) as ContactsBulkRejectedError;
    expect(e2.errors).toEqual([{ index: 0, field: "notes", message: "Enthält unzulässige Steuerzeichen" }]);
    expect(await count(org)).toBe(1);
  });

  it("ungueltige Leitweg-ID -> field leitwegId", async () => {
    const org = await makeOrg("Bulk Leitweg GmbH", "D18D6L-");
    const e = (await createContactsBulk(org, { contacts: [base(1, { leitwegId: "xx" })] }, CTX).catch((x: unknown) => x)) as ContactsBulkRejectedError;
    expect(e.errors[0]?.field).toBe("leitwegId");
  });

  it("ActivityLog: genau ein Eintrag mit created/source, ohne Namen oder E-Mails", async () => {
    const org = await makeOrg("Bulk Log GmbH", "D18D6P-");
    await createContactsBulk(org, { contacts: [base(1, { email: "log@example.org" }), base(2)] }, { actor: "test", source: "MCP" });
    const logs = await dbInternal.activityLog.findMany({ where: { orgId: org, type: "CONTACTS_BULK_CREATED" } });
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!.dataJson ?? "{}")).toEqual({ created: 2, source: "MCP" });
    expect(logs[0]!.dataJson).not.toContain("Bulk Kunde");
  });

  it("Rate-Limit: 11. Aufruf in einer Minute -> RateLimitError", async () => {
    const org = await makeOrg("Bulk Limit GmbH", "D18D6R-");
    for (let i = 0; i < 10; i++) await createContactsBulk(org, { contacts: [base(i)] }, CTX);
    await expect(createContactsBulk(org, { contacts: [base(99)] }, CTX)).rejects.toBeInstanceOf(RateLimitError);
  });

  it("parallel mit derselben Kundennummer: genau einer erfolgreich", async () => {
    const org = await makeOrg("Bulk Parallel GmbH", "D18D6Q-");
    const results = await Promise.allSettled([
      createContactsBulk(org, { contacts: [base(1, { customerNumber: "PAR-1" })] }, CTX),
      createContactsBulk(org, { contacts: [base(2, { customerNumber: "PAR-1" })] }, CTX),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await dbInternal.customer.count({ where: { orgId: org, customerNumber: "PAR-1" } })).toBe(1);
  });
});

function rest(body: unknown, opts: { token?: string; key?: string | null; raw?: string } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${opts.token ?? writeToken}`, "content-type": "application/json" };
  if (opts.key !== null) headers["idempotency-key"] = opts.key ?? "bulk-default";
  return bulkPost(new Request("http://x/api/v1/Contact/bulk", { method: "POST", headers, body: opts.raw ?? JSON.stringify(body) }));
}

describe("POST /api/v1/Contact/bulk", () => {
  it("ohne Idempotency-Key -> 400", async () => {
    const res = await rest({ contacts: [base(1)] }, { key: null });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("Idempotency-Key ist bei Sammelanlagen Pflicht.");
  });

  it("201, Replay liefert dieselbe Antwort ohne weitere Kunden", async () => {
    const before = await count();
    const res = await rest({ contacts: [base(11), base(12)] }, { key: "bulk-ok" });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { created: number; contacts: { name: string }[] } };
    expect(json.data.created).toBe(2);
    expect(json.data.contacts).toHaveLength(2);
    const replay = await rest({ contacts: [base(11), base(12)] }, { key: "bulk-ok" });
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(json);
    expect(await count()).toBe(before + 2);
  });

  it("422 mit details (errorCount, errors)", async () => {
    const res = await rest({ contacts: [base(21), base(22, { email: "kein-at" })] }, { key: "bulk-422" });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: { code: string; details: { errorCount: number; errors: { index: number; field: string }[] } } };
    expect(json.error.code).toBe("UNPROCESSABLE");
    expect(json.error.details.errorCount).toBe(1);
    expect(json.error.details.errors[0]).toMatchObject({ index: 1, field: "email" });
  });

  it("101 -> 400; Leseschluessel -> 403", async () => {
    const many = Array.from({ length: 101 }, (_, i) => base(i));
    expect((await rest({ contacts: many }, { key: "bulk-101" })).status).toBe(400);
    expect((await rest({ contacts: [base(1)] }, { token: readToken, key: "bulk-ro" })).status).toBe(403);
  });

  it("11. Aufruf -> 429 mit Retry-After", async () => {
    const org = await makeOrg("Bulk REST Limit GmbH", "D18D6M-");
    const token = (await createApiKey(org, { name: "Limit-Schreiber", scopes: ["write"], expiresAt: null })).token;
    for (let i = 0; i < 10; i++) expect((await rest({ contacts: [base(i)] }, { token, key: `lim-${i}` })).status).toBe(201);
    const res = await rest({ contacts: [base(50)] }, { token, key: "lim-x" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).not.toBeNull();
  });
});

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}
const callTool = (name: string, args: Record<string, unknown>) =>
  (server as unknown as { _registeredTools: Record<string, { handler: (a: Record<string, unknown>) => Promise<ToolResult> }> })._registeredTools[name]!.handler(args);

describe("MCP create_contacts", () => {
  it("legt an und nennt Anzahl und Ids", async () => {
    const res = await callTool("create_contacts", { contacts: [base(31), base(32)] });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toMatch(/^2 Kunden angelegt: /);
    const ids = res.content[0]!.text.replace(/^.*: /, "").replace(/\.$/, "").split(", ");
    expect(await dbInternal.customer.count({ where: { orgId, id: { in: ids } } })).toBe(2);
  });

  it("fehlerhaft -> isError mit Index, Feld, Meldung und gleicher Fehlerzahl wie REST", async () => {
    const payload = [base(41, { email: "kein-at" }), base(42), base(43, { email: "auch-kein-at" })];
    const res = await callTool("create_contacts", { contacts: payload });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("2 Fehler.");
    expect(res.content[0]!.text).toContain("Eintrag 0, email: Ungültige E-Mail-Adresse");
    const r = await rest({ contacts: payload }, { key: "bulk-parity" });
    expect(((await r.json()) as { error: { details: { errorCount: number } } }).error.details.errorCount).toBe(2);
  });
});
