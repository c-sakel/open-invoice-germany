"use server";

/**
 * Server Actions fuer Belegvorlagen (Phase 13d, Task 4) — direkt aus Client-Komponenten
 * aufgerufen (Muster src/app/actions/masterdata.ts#createCustomerInline), nicht ueber
 * `<form action>`. Zod-Validierung laeuft bereits INNERHALB der Domain-Funktionen
 * (saveTemplateFromDocumentSchema/applyTemplateSchema, src/domain/template/{save,apply}.ts)
 * — hier nur Org-Aufloesung (Session) und Fehleruebersetzung, kein Bypass-Pfad.
 *
 * "templates-doc.ts" statt "templates.ts": src/app/actions/templates.ts ist bereits die
 * E-Mail-Vorlagenverwaltung (EmailTemplate) — eigener Dateiname vermeidet eine
 * Namenskollision mit einer fachlich unverwandten Funktion.
 */
import { revalidatePath } from "next/cache";
import { getActiveOrg } from "@/lib/org";
import { saveTemplateFromDocument, deleteTemplate, renameTemplate, TemplateNameConflictError } from "@/domain/template/save";
import { z } from "zod";
import { applyTemplate, TemplateCustomerRequiredError } from "@/domain/template/apply";
import { NotFoundError } from "@/domain/errors";
import { TaxRateNotAllowedError } from "@/domain/settings/tax-rates";
import type { TagDocType } from "@/schemas/tag";

export interface TemplateActionResult {
  ok: boolean;
  error?: string;
}

export interface ApplyTemplateActionResult extends TemplateActionResult {
  /** Zielseite des neu erzeugten Entwurfs (Editor bei INVOICE/QUOTE, Detailseite bei
   *  DELIVERY_NOTE — Lieferscheine kennen keinen eigenen Editor, siehe RowActionsMenu). */
  editHref?: string;
}

/** Speichert den aktuellen Stand eines gespeicherten Belegs als Vorlage — SaveTemplateDialog
 *  (Beleg-/Listen-Mehr-Menue) UND spaeter das Anlegeformular auf /vorlagen. */
export async function saveTemplateFromDocumentAction(input: { docType: TagDocType; docId: string; name: string }): Promise<TemplateActionResult> {
  try {
    const org = await getActiveOrg();
    await saveTemplateFromDocument(org.id, input);
  } catch (e) {
    if (e instanceof NotFoundError) return { ok: false, error: "Beleg nicht gefunden." };
    if (e instanceof TemplateNameConflictError) return { ok: false, error: e.message };
    console.error("saveTemplateFromDocumentAction:", e);
    return { ok: false, error: "Vorlage konnte nicht gespeichert werden." };
  }
  revalidatePath("/vorlagen");
  return { ok: true };
}

/** Benennt eine Vorlage um (/vorlagen, inline). */
export async function renameTemplateAction(input: { id: string; name: string }): Promise<TemplateActionResult> {
  try {
    const org = await getActiveOrg();
    await renameTemplate(org.id, input.id, input.name);
  } catch (e) {
    if (e instanceof NotFoundError) return { ok: false, error: "Vorlage nicht gefunden." };
    if (e instanceof TemplateNameConflictError) return { ok: false, error: e.message };
    if (e instanceof z.ZodError) return { ok: false, error: e.issues[0]?.message ?? "Ungültiger Name." };
    console.error("renameTemplateAction:", e);
    return { ok: false, error: "Umbenennen fehlgeschlagen." };
  }
  revalidatePath("/vorlagen");
  return { ok: true };
}

/** Loescht eine Vorlage (/vorlagen). */
export async function deleteTemplateAction(input: { id: string }): Promise<TemplateActionResult> {
  try {
    const org = await getActiveOrg();
    await deleteTemplate(org.id, input.id);
  } catch (e) {
    if (e instanceof NotFoundError) return { ok: false, error: "Vorlage nicht gefunden." };
    console.error("deleteTemplateAction:", e);
    return { ok: false, error: "Löschen fehlgeschlagen." };
  }
  revalidatePath("/vorlagen");
  return { ok: true };
}

/** Erzeugt aus einer Vorlage einen neuen Belegentwurf ("Beleg erzeugen", /vorlagen) und
 *  liefert die Zielseite fuer die Weiterleitung. */
export async function applyTemplateAction(input: { id: string }): Promise<ApplyTemplateActionResult> {
  try {
    const org = await getActiveOrg();
    const { docType, id } = await applyTemplate(org.id, input.id, {});
    revalidatePath("/vorlagen");
    return { ok: true, editHref: editHrefFor(docType, id) };
  } catch (e) {
    if (e instanceof NotFoundError) return { ok: false, error: "Vorlage nicht gefunden." };
    if (e instanceof TemplateCustomerRequiredError) return { ok: false, error: e.message };
    if (e instanceof TaxRateNotAllowedError) return { ok: false, error: e.message };
    console.error("applyTemplateAction:", e);
    return { ok: false, error: "Beleg konnte nicht erzeugt werden." };
  }
}

function editHrefFor(docType: TagDocType, id: string): string {
  if (docType === "INVOICE") return `/rechnungen/${id}/bearbeiten`;
  if (docType === "QUOTE") return `/dokumente/${id}/bearbeiten`;
  // Lieferscheine kennen keinen eigenen Editor (RowActionsMenu-Kommentar) — die
  // Detailseite selbst ist der Entwurfs-Zustand.
  return `/lieferscheine/${id}`;
}
