/**
 * Phase 16b, Task 1 (Fix-Runde 1): Namenskonflikt bei Vorlagen ist je Sprache — gleicher
 * Name in de und en ist KEIN Konflikt, zweimal in derselben Sprache schon.
 */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { saveEmailTemplate, TemplateNameConflictError as EmailConflict } from "@/domain/email/templates";
import { saveTextTemplate, TemplateNameConflictError as TextConflict } from "@/domain/text-template/manage";

let orgId: string;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Vorlagensprache-Test GmbH", addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin" },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
});

afterAll(async () => {
  await dbInternal.$disconnect();
});

describe("E-Mail-Vorlagen: Konflikt je Sprache", () => {
  it("gleicher Name in en neben de ist kein Konflikt; zweites de und zweites en schon", async () => {
    await dbInternal.emailTemplate.create({
      data: { orgId, docType: "INVOICE", name: "Sprachtest", subject: "Subject", body: "Body", language: "en" },
    });
    const de = await saveEmailTemplate(orgId, { name: "Sprachtest", docType: "INVOICE", subject: "Betreff", body: "Text", isDefault: false });
    expect(de.language).toBe("de");
    await expect(
      saveEmailTemplate(orgId, { name: "Sprachtest", docType: "INVOICE", subject: "Betreff", body: "Text", isDefault: false }),
    ).rejects.toBeInstanceOf(EmailConflict);
    await expect(
      dbInternal.emailTemplate.create({ data: { orgId, docType: "INVOICE", name: "Sprachtest", subject: "S", body: "B", language: "en" } }),
    ).rejects.toThrow();
  });

  it("Umbenennen auf einen Namen, der nur in der anderen Sprache existiert, ist erlaubt", async () => {
    await dbInternal.emailTemplate.create({
      data: { orgId, docType: "INVOICE", name: "Nur-en", subject: "S", body: "B", language: "en" },
    });
    const de = await saveEmailTemplate(orgId, { name: "Zum-Umbenennen", docType: "INVOICE", subject: "B", body: "T", isDefault: false });
    const renamed = await saveEmailTemplate(orgId, { id: de.id, name: "Nur-en", docType: "INVOICE", subject: "B", body: "T", isDefault: false });
    expect(renamed.name).toBe("Nur-en");
    expect(renamed.language).toBe("de");
  });
});

describe("Textvorlagen: Konflikt je Sprache", () => {
  it("gleicher Name in en neben de ist kein Konflikt; zweites de schon", async () => {
    await dbInternal.textTemplate.create({
      data: { orgId, docType: "INVOICE", position: "HEAD", name: "Sprachtest", body: "Dear", language: "en" },
    });
    const de = await saveTextTemplate(orgId, { name: "Sprachtest", docType: "INVOICE", position: "HEAD", body: "Hallo", isDefault: false });
    expect(de.language).toBe("de");
    await expect(
      saveTextTemplate(orgId, { name: "Sprachtest", docType: "INVOICE", position: "HEAD", body: "Hallo", isDefault: false }),
    ).rejects.toBeInstanceOf(TextConflict);
  });
});
