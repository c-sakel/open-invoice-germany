/**
 * Kundenportal: Einstellungen, Token, Link anlegen/rotieren/widerrufen/aufloesen. Eigenes Jahr 2195.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { createHash } from "node:crypto";
import { dbInternal } from "@/lib/db";
import { decryptSecret, PORTAL_TOKEN_PURPOSE } from "@/lib/crypto/secrets";
import { NotFoundError } from "@/domain/errors";
import { PortalError } from "@/domain/portal/errors";
import { loadPortalSettings, savePortalSettings } from "@/domain/portal/settings";
import { archiveCustomer } from "@/domain/customer/archive";
import { createPortalLink, getPortalLinkStatus, resolvePortalToken, revealPortalUrl, revokePortalLink } from "@/domain/portal/link";

const NOW = new Date("2195-03-01T10:00:00.000Z");
const BASE = "https://rechnung.example.org";
const DAY = 86_400_000;

let orgId = "";
let otherOrgId = "";
let customerId = "";
let otherCustomerId = "";

async function newCustomer(org: string, name: string): Promise<string> {
  const c = await dbInternal.customer.create({
    data: { orgId: org, name, addressLine1: "Weg 2", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  return c.id;
}

function tokenOf(url: string): string {
  return url.slice(`${BASE}/portal/`.length);
}

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  const mk = async (n: string) =>
    (
      await dbInternal.organization.create({
        data: { legalName: n, addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" },
        select: { id: true },
      })
    ).id;
  orgId = await mk("Portal-Link GmbH");
  otherOrgId = await mk("Portal-Fremd GmbH");
  customerId = await newCustomer(orgId, "Link-Kunde");
  otherCustomerId = await newCustomer(otherOrgId, "Fremd-Kunde");
});

describe("Portal-Link", () => {
  it("Portal aus -> PORTAL_DISABLED; danach Anlage mit Hash und verschluesseltem Token", async () => {
    await expect(createPortalLink(orgId, customerId, {}, { actor: "t", now: NOW, baseUrl: BASE })).rejects.toMatchObject({
      code: "PORTAL_DISABLED",
    });
    await expect(createPortalLink(orgId, customerId, {}, { actor: "t", now: NOW, baseUrl: BASE })).rejects.toBeInstanceOf(PortalError);

    const s = await savePortalSettings(orgId, { enabled: true }, "t");
    expect(s.enabled).toBe(true);

    const { link, url } = await createPortalLink(orgId, customerId, {}, { actor: "t", now: NOW, baseUrl: BASE });
    expect(url).toMatch(/^https:\/\/rechnung\.example\.org\/portal\/[A-Za-z0-9_-]{43}$/);
    const token = tokenOf(url);
    const row = await dbInternal.customerPortalLink.findUniqueOrThrow({ where: { id: link.id } });
    expect(row.tokenHash).toBe(createHash("sha256").update(token, "utf8").digest("hex"));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(decryptSecret(row.tokenEnc, PORTAL_TOKEN_PURPOSE)).toBe(token);
    expect(link.active).toBe(true);
  });

  it("expiresAt = now + linkDays (Default 365) bzw. expiresInDays", async () => {
    const c = await newCustomer(orgId, "Ablauf-Kunde");
    const a = await createPortalLink(orgId, c, {}, { actor: "t", now: NOW, baseUrl: BASE });
    expect(a.link.expiresAt.getTime()).toBe(NOW.getTime() + 365 * DAY);
    const b = await createPortalLink(orgId, c, { expiresInDays: 10 }, { actor: "t", now: NOW, baseUrl: BASE });
    expect(b.link.expiresAt.getTime()).toBe(NOW.getTime() + 10 * DAY);
    await expect(createPortalLink(orgId, c, { expiresInDays: 0 }, { actor: "t", now: NOW, baseUrl: BASE })).rejects.toBeInstanceOf(ZodError);
  });

  it("zweiter Aufruf rotiert: alter Link widerrufen, alter Token loest nicht mehr auf", async () => {
    const c = await newCustomer(orgId, "Rotations-Kunde");
    const first = await createPortalLink(orgId, c, {}, { actor: "t", now: NOW, baseUrl: BASE });
    const second = await createPortalLink(orgId, c, {}, { actor: "u", now: NOW, baseUrl: BASE });
    const old = await dbInternal.customerPortalLink.findUniqueOrThrow({ where: { id: first.link.id } });
    expect(old.revokedAt).toEqual(NOW);
    expect(old.revokeReason).toBe("ROTATED");
    expect(old.revokedBy).toBe("u");
    expect(old.tokenEnc).toBe("");
    expect(await resolvePortalToken(tokenOf(first.url), NOW)).toBeNull();
    expect(await resolvePortalToken(tokenOf(second.url), NOW)).not.toBeNull();
    expect((await dbInternal.customerPortalLink.findUniqueOrThrow({ where: { id: second.link.id }, select: { tokenEnc: true } })).tokenEnc).not.toBe("");
  });

  it("parallele Anlage -> genau ein aktiver Link", async () => {
    const c = await newCustomer(orgId, "Parallel-Kunde");
    await Promise.all([
      createPortalLink(orgId, c, {}, { actor: "t", now: NOW, baseUrl: BASE }),
      createPortalLink(orgId, c, {}, { actor: "t", now: NOW, baseUrl: BASE }),
    ]);
    const active = await dbInternal.customerPortalLink.count({ where: { orgId, customerId: c, revokedAt: null } });
    expect(active).toBe(1);
    expect(await dbInternal.customerPortalLink.count({ where: { orgId, customerId: c } })).toBe(2);
  });

  it("resolve: null bei unbekannt, Format, widerrufen, abgelaufen, Portal aus, Kunde archiviert", async () => {
    const c = await newCustomer(orgId, "Resolve-Kunde");
    const { url, link } = await createPortalLink(orgId, c, {}, { actor: "t", now: NOW, baseUrl: BASE });
    const token = tokenOf(url);
    const ok = await resolvePortalToken(token, NOW);
    expect(ok).toMatchObject({ linkId: link.id, orgId, customerId: c, customerName: "Resolve-Kunde", showDunnings: true, showEInvoice: true });

    expect(await resolvePortalToken("A".repeat(43), NOW)).toBeNull();
    expect(await resolvePortalToken("kurz", NOW)).toBeNull();
    expect(await resolvePortalToken(`${token}x`, NOW)).toBeNull();
    // abgelaufen: exakt expiresAt
    expect(await resolvePortalToken(token, link.expiresAt)).toBeNull();
    expect(await resolvePortalToken(token, new Date(link.expiresAt.getTime() - 1))).not.toBeNull();

    await savePortalSettings(orgId, { enabled: false }, "t");
    expect(await resolvePortalToken(token, NOW)).toBeNull();
    await savePortalSettings(orgId, { enabled: true }, "t");
    expect(await resolvePortalToken(token, NOW)).not.toBeNull();

    await dbInternal.customer.update({ where: { id: c }, data: { isArchived: true } });
    expect(await resolvePortalToken(token, NOW)).toBeNull();
    await dbInternal.customer.update({ where: { id: c }, data: { isArchived: false } });

    await revokePortalLink(orgId, c, { actor: "t", now: NOW });
    expect(await resolvePortalToken(token, NOW)).toBeNull();
  });

  it("Link bindet die Organisation: fremde Org kann nicht anlegen oder widerrufen", async () => {
    await savePortalSettings(otherOrgId, { enabled: true }, "t");
    await expect(createPortalLink(otherOrgId, customerId, {}, { actor: "t", now: NOW, baseUrl: BASE })).rejects.toBeInstanceOf(NotFoundError);
    await expect(createPortalLink(orgId, "unbekannt", {}, { actor: "t", now: NOW, baseUrl: BASE })).rejects.toBeInstanceOf(NotFoundError);
    const own = await createPortalLink(otherOrgId, otherCustomerId, {}, { actor: "t", now: NOW, baseUrl: BASE });
    const r = await resolvePortalToken(tokenOf(own.url), NOW);
    expect(r?.orgId).toBe(otherOrgId);
    expect(await revokePortalLink(orgId, otherCustomerId, { actor: "t", now: NOW })).toBeNull();
    expect(await resolvePortalToken(tokenOf(own.url), NOW)).not.toBeNull();
    expect(await getPortalLinkStatus(orgId, otherCustomerId, NOW)).toBeNull();
  });

  it("archivierter Kunde -> CUSTOMER_ARCHIVED", async () => {
    const c = await newCustomer(orgId, "Archiv-Kunde");
    await dbInternal.customer.update({ where: { id: c }, data: { isArchived: true } });
    await expect(createPortalLink(orgId, c, {}, { actor: "t", now: NOW, baseUrl: BASE })).rejects.toMatchObject({ code: "CUSTOMER_ARCHIVED" });
  });

  it("revealPortalUrl liefert dieselbe URL, nach Widerruf null", async () => {
    const c = await newCustomer(orgId, "Reveal-Kunde");
    expect(await revealPortalUrl(orgId, c, BASE, NOW)).toBeNull();
    const { url } = await createPortalLink(orgId, c, {}, { actor: "t", now: NOW, baseUrl: `${BASE}/` });
    expect(url.startsWith(`${BASE}/portal/`)).toBe(true);
    expect(await revealPortalUrl(orgId, c, BASE, NOW)).toBe(url);
    const status = await revokePortalLink(orgId, c, { actor: "t", now: NOW });
    expect(status).toMatchObject({ active: false, revokeReason: "MANUAL" });
    expect(await revealPortalUrl(orgId, c, BASE, NOW)).toBeNull();
    expect(await revokePortalLink(orgId, c, { actor: "t", now: NOW })).toBeNull();
  });

  it("ActivityLog: CREATED/REVOKED mit Link-Id, nie mit Token", async () => {
    const c = await newCustomer(orgId, "Log-Kunde");
    const { url, link } = await createPortalLink(orgId, c, {}, { actor: "t", now: NOW, baseUrl: BASE });
    await revokePortalLink(orgId, c, { actor: "t", now: NOW });
    const rows = await dbInternal.activityLog.findMany({
      where: { orgId, entityType: "CUSTOMER", entityId: c },
      select: { type: true, dataJson: true, actor: true },
    });
    expect(rows.map((r) => r.type).sort()).toEqual(["PORTAL_LINK_CREATED", "PORTAL_LINK_REVOKED"]);
    for (const r of rows) {
      expect(r.dataJson).toContain(link.id);
      expect(JSON.stringify(r)).not.toContain(tokenOf(url));
    }
  });

  it("Einstellungen: Teil-Update laesst andere Felder, Validierung", async () => {
    const before = await loadPortalSettings(orgId);
    expect(before.enabled).toBe(true);
    const after = await savePortalSettings(orgId, { linkDays: 30 }, "t");
    expect(after).toMatchObject({ enabled: true, linkDays: 30, showDunnings: true });
    await expect(savePortalSettings(orgId, { linkDays: 0 }, "t")).rejects.toBeInstanceOf(ZodError);
    await expect(savePortalSettings(orgId, { linkDays: 731 }, "t")).rejects.toBeInstanceOf(ZodError);
    await savePortalSettings(orgId, { linkDays: 365 }, "t");
    // ohne Zeile: Standardwerte
    const fresh = await dbInternal.organization.create({
      data: { legalName: "Portal-Leer GmbH", addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" },
      select: { id: true },
    });
    expect(await loadPortalSettings(fresh.id)).toMatchObject({ enabled: false, linkDays: 365 });
  });

  it("Kunde archivieren widerruft den aktiven Link in derselben Transaktion", async () => {
    const c = await newCustomer(orgId, "Archiv-Widerruf-Kunde");
    const { url, link } = await createPortalLink(orgId, c, {}, { actor: "t", now: NOW, baseUrl: BASE });
    await archiveCustomer(orgId, c, "t");
    const after = await getPortalLinkStatus(orgId, c, NOW);
    expect(after?.id).toBe(link.id);
    expect(after?.active).toBe(false);
    expect(after?.revokeReason).toBe("CUSTOMER_ARCHIVED");
    expect(await resolvePortalToken(tokenOf(url), NOW)).toBeNull();
    expect((await dbInternal.customerPortalLink.findUniqueOrThrow({ where: { id: link.id }, select: { tokenEnc: true } })).tokenEnc).toBe("");
    // Wiederherstellen des Kunden reaktiviert den widerrufenen Link nicht.
    await dbInternal.customer.update({ where: { id: c }, data: { isArchived: false } });
    expect(await resolvePortalToken(tokenOf(url), NOW)).toBeNull();
    expect((await getPortalLinkStatus(orgId, c, NOW))?.active).toBe(false);
    expect(await revealPortalUrl(orgId, c, BASE, NOW)).toBeNull();
    await expect(archiveCustomer(orgId, "unbekannt", "t")).rejects.toBeInstanceOf(NotFoundError);
    await expect(archiveCustomer(otherOrgId, c, "t")).rejects.toBeInstanceOf(NotFoundError);
  });
});
