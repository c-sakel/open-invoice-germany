"use server";

import { revalidatePath } from "next/cache";
import { dbInternal } from "@/lib/db";
import { getActiveOrg } from "@/lib/org";
import { emailTemplateInputSchema } from "@/schemas/email";
import { saveEmailTemplate } from "@/domain/email/templates";
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

  try {
    const org = await getActiveOrg();
    await saveEmailTemplate(org.id, parsed.data);
  } catch (e) {
    console.error("saveEmailTemplateAction:", e);
    return { ok: false, error: e instanceof Error ? e.message : "Speichern fehlgeschlagen." };
  }
  revalidatePath("/einstellungen/vorlagen");
  return { ok: true };
}

/** Loescht eine Vorlage. Eine Systemvorlage darf nur geloescht werden, wenn fuer denselben
 *  Dokumenttyp eine ANDERE Vorlage bereits als Standard markiert ist. */
export async function deleteEmailTemplateAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const id = str(fd, "id");
  if (!id) return { ok: false, error: "Vorlage nicht gefunden." };

  try {
    const org = await getActiveOrg();
    const tpl = await dbInternal.emailTemplate.findFirst({ where: { id, orgId: org.id } });
    if (!tpl) return { ok: false, error: "Vorlage nicht gefunden." };

    if (tpl.isSystem) {
      const otherDefault = await dbInternal.emailTemplate.count({
        where: { orgId: org.id, docType: tpl.docType, isDefault: true, id: { not: tpl.id } },
      });
      if (otherDefault === 0) {
        return {
          ok: false,
          error: "Systemvorlage kann nicht gelöscht werden: keine andere Standardvorlage für diesen Dokumenttyp vorhanden.",
        };
      }
    }

    await dbInternal.emailTemplate.delete({ where: { id: tpl.id } });
  } catch (e) {
    console.error("deleteEmailTemplateAction:", e);
    return { ok: false, error: "Löschen fehlgeschlagen." };
  }
  revalidatePath("/einstellungen/vorlagen");
  return { ok: true };
}

/** Setzt eine Vorlage als Standard fuer ihren Dokumenttyp; alle anderen Vorlagen desselben
 *  Typs werden in derselben Transaktion auf `isDefault = false` gesetzt. */
export async function setDefaultEmailTemplateAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const id = str(fd, "id");
  if (!id) return { ok: false, error: "Vorlage nicht gefunden." };

  try {
    const org = await getActiveOrg();
    const tpl = await dbInternal.emailTemplate.findFirst({ where: { id, orgId: org.id } });
    if (!tpl) return { ok: false, error: "Vorlage nicht gefunden." };

    await dbInternal.$transaction(async (tx) => {
      await tx.emailTemplate.updateMany({ where: { orgId: org.id, docType: tpl.docType }, data: { isDefault: false } });
      await tx.emailTemplate.update({ where: { id: tpl.id }, data: { isDefault: true } });
    });
  } catch (e) {
    console.error("setDefaultEmailTemplateAction:", e);
    return { ok: false, error: "Aktion fehlgeschlagen." };
  }
  revalidatePath("/einstellungen/vorlagen");
  return { ok: true };
}
