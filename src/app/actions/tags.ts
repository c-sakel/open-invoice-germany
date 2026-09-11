"use server";

/**
 * Server Actions fuer Tags (Phase 13d, Task 4) — direkt aus Client-Komponenten aufgerufen
 * (Muster src/app/actions/masterdata.ts#createCustomerInline), nicht ueber `<form action>`:
 * TagManager/TagPicker rufen sie als normale async Funktionen auf und werten das
 * Rueckgabeobjekt aus. Zod-Validierung laeuft bereits INNERHALB der Domain-Funktionen
 * (tagInputSchema/tagAssignSchema, src/domain/tag/{manage,assign}.ts) — hier nur die
 * Org-Aufloesung (Session) und die Uebersetzung der Domain-Fehlerklassen in
 * anwenderverstaendliche Meldungen, kein Bypass-Pfad.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getActiveOrg } from "@/lib/org";
import { saveTag, deleteTag, TagNotFoundError, TagNameConflictError } from "@/domain/tag/manage";
import { tagDocument, untagDocument } from "@/domain/tag/assign";
import { NotFoundError } from "@/domain/errors";
import { RelationError } from "@/domain/relations";
import type { TagColor, TagDocType } from "@/schemas/tag";

export interface TagActionResult {
  ok: boolean;
  error?: string;
}

export interface DeleteTagActionResult extends TagActionResult {
  removedAssignments?: number;
}

function firstError(issues: { message: string; path: PropertyKey[] }[]): string {
  const i = issues[0];
  return i ? `${i.path.join(".") || "Eingabe"}: ${i.message}` : "Ungültige Eingabe.";
}

/** Legt einen Tag an (`id: null`) oder aendert Name/Farbe. */
export async function saveTagAction(input: { id: string | null; name: string; color?: TagColor }): Promise<TagActionResult> {
  try {
    const org = await getActiveOrg();
    await saveTag(org.id, input.id, { name: input.name, color: input.color });
  } catch (e) {
    if (e instanceof TagNotFoundError) return { ok: false, error: "Tag nicht gefunden." };
    if (e instanceof TagNameConflictError) return { ok: false, error: e.message };
    if (e instanceof z.ZodError) return { ok: false, error: firstError(e.issues) };
    console.error("saveTagAction:", e);
    return { ok: false, error: "Speichern fehlgeschlagen." };
  }
  revalidatePath("/einstellungen/tags");
  return { ok: true };
}

/** Loescht einen Tag; die Rueckgabe nennt die Anzahl der dabei entfernten Zuordnungen
 *  (Bestaetigungshinweis in TagManager). */
export async function deleteTagAction(input: { id: string }): Promise<DeleteTagActionResult> {
  try {
    const org = await getActiveOrg();
    const { removedAssignments } = await deleteTag(org.id, input.id);
    revalidatePath("/einstellungen/tags");
    return { ok: true, removedAssignments };
  } catch (e) {
    if (e instanceof TagNotFoundError) return { ok: false, error: "Tag nicht gefunden." };
    console.error("deleteTagAction:", e);
    return { ok: false, error: "Löschen fehlgeschlagen." };
  }
}

/** Ordnet einen Tag einem Beleg zu (auch an festgeschriebenen Belegen erlaubt, siehe
 *  src/domain/tag/assign.ts). Revalidiert die jeweilige Belegdetailseite, damit die
 *  Tag-Chips ohne manuellen Reload aktuell sind. */
export async function tagDocumentAction(input: { docType: TagDocType; docId: string; tagId: string }): Promise<TagActionResult> {
  try {
    const org = await getActiveOrg();
    await tagDocument(org.id, input.tagId, { docType: input.docType, docId: input.docId });
  } catch (e) {
    if (e instanceof NotFoundError) return { ok: false, error: "Tag nicht gefunden." };
    if (e instanceof RelationError) return { ok: false, error: "Beleg nicht gefunden." };
    console.error("tagDocumentAction:", e);
    return { ok: false, error: "Tag konnte nicht gesetzt werden." };
  }
  revalidatePath(docPath(input.docType, input.docId));
  return { ok: true };
}

/** Entfernt die Zuordnung eines Tags von einem Beleg. */
export async function untagDocumentAction(input: { docType: TagDocType; docId: string; tagId: string }): Promise<TagActionResult> {
  try {
    const org = await getActiveOrg();
    await untagDocument(org.id, input.tagId, { docType: input.docType, docId: input.docId });
  } catch (e) {
    if (e instanceof NotFoundError) return { ok: false, error: "Tag nicht gefunden." };
    console.error("untagDocumentAction:", e);
    return { ok: false, error: "Tag konnte nicht entfernt werden." };
  }
  revalidatePath(docPath(input.docType, input.docId));
  return { ok: true };
}

function docPath(docType: TagDocType, docId: string): string {
  if (docType === "INVOICE") return `/rechnungen/${docId}`;
  if (docType === "QUOTE") return `/dokumente/${docId}`;
  return `/lieferscheine/${docId}`;
}
