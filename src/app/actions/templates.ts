"use server";

import { revalidatePath } from "next/cache";
import { dbInternal } from "@/lib/db";
import { getActiveOrg } from "@/lib/org";
import { emailTemplateInputSchema } from "@/schemas/email";
import type { ActionResult } from "./result";

function str(fd: FormData, key: string): string | undefined {
  const v = fd.get(key);
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? undefined : s;
}
function firstError(issues: { message: string; path: PropertyKey[] }[]): string {
  const i = issues[0];
  return i ? `${i.path.join(".") || "Eingabe"}: ${i.message}` : "Ungültige Eingabe";
}

/** Legt eine Vorlage an oder aktualisiert sie. Wird `isDefault` gesetzt, werden alle
 *  anderen Vorlagen desselben Dokumenttyps in derselben Transaktion auf `false` gesetzt. */
export async function saveEmailTemplateAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const parsed = emailTemplateInputSchema.safeParse({
    id: str(fd, "id"),
    name: str(fd, "name"),
    docType: str(fd, "docType"),
    subject: str(fd, "subject"),
    body: str(fd, "body"),
    signature: str(fd, "signature"),
    isDefault: fd.get("isDefault") === "on",
  });
  if (!parsed.success) return { ok: false, error: firstError(parsed.error.issues) };
  const v = parsed.data;

  try {
    const org = await getActiveOrg();
    const data = {
      orgId: org.id,
      docType: v.docType,
      name: v.name,
      subject: v.subject,
      body: v.body,
      signature: v.signature ?? null,
      isDefault: v.isDefault,
    };

    await dbInternal.$transaction(async (tx) => {
      let templateId = v.id;
      if (templateId) {
        const existing = await tx.emailTemplate.findFirst({ where: { id: templateId, orgId: org.id } });
        if (!existing) throw new Error("Vorlage nicht gefunden.");
        await tx.emailTemplate.update({ where: { id: templateId }, data });
      } else {
        const created = await tx.emailTemplate.create({ data });
        templateId = created.id;
      }
      if (v.isDefault) {
        await tx.emailTemplate.updateMany({
          where: { orgId: org.id, docType: v.docType, id: { not: templateId } },
          data: { isDefault: false },
        });
      }
    });
  } catch (e) {
    console.error("saveEmailTemplateAction:", e);
    return { ok: false, error: e instanceof Error ? e.message : "Speichern fehlgeschlagen." };
  }
  revalidatePath("/einstellungen/vorlagen");
  return { ok: true };
}

/** Loescht eine Vorlage. Eine Systemvorlage darf nur geloescht werden, wenn fuer denselben
 *  Dokumenttyp eine ANDERE Vorlage bereits als Standard markiert ist. */
export async function deleteEmailTemplateAction(id: string): Promise<void> {
  const org = await getActiveOrg();
  const tpl = await dbInternal.emailTemplate.findFirst({ where: { id, orgId: org.id } });
  if (!tpl) return;

  if (tpl.isSystem) {
    const otherDefault = await dbInternal.emailTemplate.count({
      where: { orgId: org.id, docType: tpl.docType, isDefault: true, id: { not: tpl.id } },
    });
    if (otherDefault === 0) {
      throw new Error("Systemvorlage kann nicht geloescht werden: keine andere Standardvorlage fuer diesen Dokumenttyp vorhanden.");
    }
  }

  await dbInternal.emailTemplate.delete({ where: { id: tpl.id } });
  revalidatePath("/einstellungen/vorlagen");
}

/** Setzt eine Vorlage als Standard fuer ihren Dokumenttyp; alle anderen Vorlagen desselben
 *  Typs werden in derselben Transaktion auf `isDefault = false` gesetzt. */
export async function setDefaultEmailTemplateAction(id: string): Promise<void> {
  const org = await getActiveOrg();
  const tpl = await dbInternal.emailTemplate.findFirst({ where: { id, orgId: org.id } });
  if (!tpl) return;

  await dbInternal.$transaction(async (tx) => {
    await tx.emailTemplate.updateMany({ where: { orgId: org.id, docType: tpl.docType }, data: { isDefault: false } });
    await tx.emailTemplate.update({ where: { id: tpl.id }, data: { isDefault: true } });
  });
  revalidatePath("/einstellungen/vorlagen");
}
