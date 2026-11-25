/**
 * Alarm-Mail (sendAlarmMailIfDue, runNotificationsJob). Keine Belege, daher kein Testjahr noetig;
 * je Test eigene Organisation.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { dbInternal } from "@/lib/db";
import { saveMailSettings } from "@/domain/email/settings";
import { createMemoryProvider } from "@/lib/mail/memory";
import { createNotification } from "@/domain/notifications/create";
import { sendAlarmMailIfDue } from "@/domain/notifications/alarm-mail";
import { runNotificationsJob } from "@/domain/notifications/job";
import { loadNotificationSettings, saveNotificationSettings, ALL_NOTIFICATION_TYPES } from "@/domain/notifications/settings";

const NOW = new Date("2273-06-09T10:00:00.000Z");
const H = 60 * 60 * 1000;

async function makeOrg(withMail = true): Promise<string> {
  const org = await dbInternal.organization.create({
    data: { legalName: "Alarm Test GmbH", addressLine1: "Teststr. 1", postalCode: "12345", city: "Berlin", email: "firma@example.org" },
  });
  if (withMail) {
    await saveMailSettings(org.id, { host: "localhost", port: 2525, security: "NONE", fromName: "Alarm Test", fromEmail: "absender@example.org", defaultCc: "", defaultBcc: "", copyToSelf: false });
  }
  return org.id;
}

async function alarm(orgId: string, key: string, at: Date = NOW, type: "ARCHIVE_FAILED" | "INVOICE_OVERDUE" | "CHAIN_BROKEN" | "RECURRING_FAILED" = "ARCHIVE_FAILED", title = `Meldung ${key}`) {
  const res = await createNotification({ orgId, type, title, link: `/x/${key}`, dedupeKey: key, at });
  if (!res) throw new Error("Dedupe");
  return res.id;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Alarm-Mail", () => {
  it("1. neuer Alarm -> eine Mail an die Firmenadresse, alarmMailedAt gesetzt", async () => {
    const orgId = await makeOrg();
    const id = await alarm(orgId, "a1");
    const provider = createMemoryProvider();
    expect(await sendAlarmMailIfDue(orgId, NOW, provider)).toBe(1);
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].to).toEqual(["firma@example.org"]);
    expect(provider.sent[0].subject).toBe("Alarm: 1 Meldung(en) – OpenInvoice Germany");
    expect(provider.sent[0].text).toContain("Archivierung fehlgeschlagen");
    expect(provider.sent[0].text).not.toContain("Meldung a1");
    const row = await dbInternal.notification.findUniqueOrThrow({ where: { id }, select: { alarmMailedAt: true } });
    expect(row.alarmMailedAt?.getTime()).toBe(NOW.getTime());
  });

  it("2. innerhalb 60 min keine Mail, danach nur der neue Alarm", async () => {
    const orgId = await makeOrg();
    await alarm(orgId, "b1");
    const provider = createMemoryProvider();
    await sendAlarmMailIfDue(orgId, NOW, provider);
    await alarm(orgId, "b2", new Date(NOW.getTime() + 10 * 60_000), "CHAIN_BROKEN");
    expect(await sendAlarmMailIfDue(orgId, new Date(NOW.getTime() + 30 * 60_000), provider)).toBe(0);
    expect(provider.sent).toHaveLength(1);
    expect(await sendAlarmMailIfDue(orgId, new Date(NOW.getTime() + H), provider)).toBe(1);
    expect(provider.sent).toHaveLength(2);
    expect(provider.sent[1].text).toContain("Hash-Kette gebrochen");
    expect(provider.sent[1].text).not.toContain("Archivierung fehlgeschlagen");
  });

  it("3. alarmEmail=false -> keine Mail", async () => {
    const orgId = await makeOrg();
    await saveNotificationSettings(orgId, { enabledTypes: [...ALL_NOTIFICATION_TYPES], emailDigest: false, alarmEmail: false });
    await alarm(orgId, "c1");
    const provider = createMemoryProvider();
    expect(await sendAlarmMailIfDue(orgId, NOW, provider)).toBe(0);
    expect(provider.sent).toHaveLength(0);
  });

  it("4. Alarm aelter als 48 h oder gelesen -> keine Mail", async () => {
    const orgId = await makeOrg();
    await alarm(orgId, "d1", new Date(NOW.getTime() - 49 * H));
    const readId = await alarm(orgId, "d2");
    await dbInternal.notification.update({ where: { id: readId }, data: { readAt: NOW } });
    const provider = createMemoryProvider();
    expect(await sendAlarmMailIfDue(orgId, NOW, provider)).toBe(0);
    expect(provider.sent).toHaveLength(0);
  });

  it("5. Nicht-Alarmtyp -> keine Mail", async () => {
    const orgId = await makeOrg();
    await alarm(orgId, "e1", NOW, "INVOICE_OVERDUE");
    const provider = createMemoryProvider();
    expect(await sendAlarmMailIfDue(orgId, NOW, provider)).toBe(0);
    expect(provider.sent).toHaveLength(0);
  });

  it("6. Provider wirft (Ausgang unklar) -> keine neue Benachrichtigung, Lauf ok, Alarm nicht erneut gemailt", async () => {
    const orgId = await makeOrg();
    await alarm(orgId, "f1");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const provider = createMemoryProvider();
    provider.failNext("kaputt");
    const before = await dbInternal.notification.count({ where: { orgId } });
    expect(await sendAlarmMailIfDue(orgId, NOW, provider)).toBe(0);
    expect(errSpy).toHaveBeenCalled();
    expect(await dbInternal.notification.count({ where: { orgId } })).toBe(before);
    expect(await sendAlarmMailIfDue(orgId, new Date(NOW.getTime() + 2 * H), provider)).toBe(0);
    expect(provider.sent).toHaveLength(0);
  });

  it("6b. sicher nicht gesendet (NOT_SENT) -> Claim und Takt zurueckgesetzt, naechster Lauf versendet", async () => {
    const orgId = await makeOrg();
    const id = await alarm(orgId, "f2");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const provider = createMemoryProvider();
    provider.failNext("kein Verbindungsaufbau", "NOT_SENT");
    expect(await sendAlarmMailIfDue(orgId, NOW, provider)).toBe(0);
    const row = await dbInternal.notification.findUniqueOrThrow({ where: { id }, select: { alarmMailedAt: true } });
    expect(row.alarmMailedAt).toBeNull();
    expect((await loadNotificationSettings(orgId)).lastAlarmMailAt).toBeNull();
    expect(await sendAlarmMailIfDue(orgId, new Date(NOW.getTime() + 60_000), provider)).toBe(1);
    expect(provider.sent).toHaveLength(1);
  });

  it("6c. Ausnahme vor dem SMTP-Aufruf -> Claim und Takt zurueckgesetzt (es ging sicher nichts raus), naechster Lauf versendet", async () => {
    const orgId = await makeOrg();
    const id = await alarm(orgId, "f3");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(dbInternal.organization, "findUnique").mockRejectedValueOnce(new Error("DB weg"));
    const provider = createMemoryProvider();
    expect(await sendAlarmMailIfDue(orgId, NOW, provider)).toBe(0);
    expect(provider.sent).toHaveLength(0);
    const row = await dbInternal.notification.findUniqueOrThrow({ where: { id }, select: { alarmMailedAt: true } });
    expect(row.alarmMailedAt).toBeNull();
    expect((await loadNotificationSettings(orgId)).lastAlarmMailAt).toBeNull();
    expect(await sendAlarmMailIfDue(orgId, new Date(NOW.getTime() + 60_000), provider)).toBe(1);
    expect(provider.sent).toHaveLength(1);
  });

  it("Mailtext: nur feste Bezeichnung und Anzahl, nie freie Titel oder Kundennamen", async () => {
    const orgId = await makeOrg();
    await alarm(orgId, "i1", NOW, "RECURRING_FAILED", "Abo Mustermann Kunde GmbH RE-12345");
    await alarm(orgId, "i2", NOW, "RECURRING_FAILED", "Abo Beispiel AG");
    const provider = createMemoryProvider();
    expect(await sendAlarmMailIfDue(orgId, NOW, provider)).toBe(2);
    const text = provider.sent[0].text;
    expect(text).toContain("Wiederkehrende Rechnung fehlgeschlagen (2x)");
    expect(text).not.toContain("Mustermann");
    expect(text).not.toContain("Beispiel AG");
    expect(text).not.toContain("RE-12345");
    expect(text).not.toContain("/x/");
  });

  it("Link-Zeile nur mit APP_BASE_URL", async () => {
    const orgId = await makeOrg();
    await alarm(orgId, "j1");
    const provider = createMemoryProvider();
    vi.stubEnv("APP_BASE_URL", "https://rechnung.example.org/");
    await sendAlarmMailIfDue(orgId, NOW, provider);
    expect(provider.sent[0].text).toContain("Details: https://rechnung.example.org/benachrichtigungen");
    const org2 = await makeOrg();
    await alarm(org2, "j2");
    vi.stubEnv("APP_BASE_URL", "");
    const p2 = createMemoryProvider();
    await sendAlarmMailIfDue(org2, NOW, p2);
    expect(p2.sent[0].text).not.toContain("Details:");
    vi.unstubAllEnvs();
  });

  it("Firma ohne E-Mail-Adresse -> Absenderadresse der Mail-Einstellungen", async () => {
    const orgId = await makeOrg();
    await dbInternal.organization.update({ where: { id: orgId }, data: { email: null } });
    await alarm(orgId, "k1");
    const provider = createMemoryProvider();
    expect(await sendAlarmMailIfDue(orgId, NOW, provider)).toBe(1);
    expect(provider.sent[0].to).toEqual(["absender@example.org"]);
  });

  it("parallele Laeufe -> genau eine Mail", async () => {
    const orgId = await makeOrg();
    await alarm(orgId, "l1");
    const provider = createMemoryProvider();
    const results = await Promise.all([sendAlarmMailIfDue(orgId, NOW, provider), sendAlarmMailIfDue(orgId, NOW, provider), sendAlarmMailIfDue(orgId, NOW, provider)]);
    expect(provider.sent).toHaveLength(1);
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("7. Bestandseinstellung ohne Zeile -> Standard an (ueber den Scheduler-Job, vor dem Digest)", async () => {
    const orgId = await makeOrg();
    expect(await dbInternal.notificationSettings.findUnique({ where: { orgId } })).toBeNull();
    await alarm(orgId, "g1");
    const provider = createMemoryProvider();
    const result = await runNotificationsJob(NOW, { orgId, provider });
    expect(result.errors).toEqual([]);
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].subject).toContain("Alarm:");
    expect((await loadNotificationSettings(orgId)).alarmEmail).toBe(true);
  });

  it("ohne Mail-Konfiguration -> keine Mail, Alarm bleibt offen", async () => {
    const orgId = await makeOrg(false);
    const id = await alarm(orgId, "h1");
    const provider = createMemoryProvider();
    expect(await sendAlarmMailIfDue(orgId, NOW, provider)).toBe(0);
    const row = await dbInternal.notification.findUniqueOrThrow({ where: { id }, select: { alarmMailedAt: true } });
    expect(row.alarmMailedAt).toBeNull();
  });
});
