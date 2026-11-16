"use server";

/**
 * Server-Actions der DATEV-Seite. Jede Action prueft den Ursprung der Anfrage (same-origin), validiert mit Zod
 * und ruft dieselben Domainfunktionen wie REST und MCP. Nur hier gibt es die Bestaetigung der Kontenzuordnung;
 * Rollen kennt das Programm nicht, Zugriff haben angemeldete Benutzer der Organisation.
 */
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";
import { requireActionOrg, requireSessionActor } from "@/lib/auth/require-session";
import { isSameOriginHeaders } from "@/lib/http/same-origin";
import { describeError } from "@/lib/safe-error";
import { confirmDatevMapping, saveDatevSettings } from "@/domain/export/datev/settings";
import { applyDatevTemplate, saveDatevMapping } from "@/domain/export/datev/mapping";
import { planDatevExport, runDatevExport } from "@/domain/export/datev/run";
import { DatevError, DatevExportError } from "@/domain/export/datev/errors";
import { toHistoryRow, toPreviewDto, type HistoryRowDto, type PreviewDto } from "@/domain/export/datev/ui";
import {
  datevConfirmNoteSchema,
  datevExportRequestSchema,
  datevMappingInputSchema,
  datevSettingsInputSchema,
  datevTemplateInputSchema,
} from "@/schemas/datev";

export type DatevActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const FORBIDDEN = "Anfrage nicht zulässig.";

async function guard(): Promise<{ orgId: string; actor: string }> {
  const h = await headers();
  if (!isSameOriginHeaders(h, h.get("host") ?? "")) throw new DatevError("VALIDATION", FORBIDDEN);
  const org = await requireActionOrg();
  return { orgId: org.id, actor: await requireSessionActor() };
}

function errorText(e: unknown): string {
  if (e instanceof ZodError) {
    const i = e.issues[0];
    return i ? i.message : "Ungültige Eingabe.";
  }
  if (e instanceof DatevExportError) {
    const lines = (e.details.issues ?? []).slice(0, 10).map((i) => i.message);
    const months = e.details.months?.length ? ` Betroffene Monate: ${e.details.months.join(", ")}.` : "";
    return [e.message + months, ...lines].join("\n");
  }
  if (e instanceof DatevError) return e.message;
  console.error("datev action:", describeError(e));
  return "Die Aktion ist fehlgeschlagen.";
}

function refresh(): void {
  revalidatePath("/einstellungen/datev");
}

export async function saveDatevSettingsAction(input: unknown): Promise<DatevActionResult> {
  try {
    const { orgId, actor } = await guard();
    const parsed = datevSettingsInputSchema.parse(input);
    await saveDatevSettings(orgId, parsed, actor);
    refresh();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

export async function applyDatevTemplateAction(
  input: unknown,
): Promise<DatevActionResult<{ added: number; replaced: number; keptEdited: string[]; withoutSuggestion: string[] }>> {
  try {
    const { orgId, actor } = await guard();
    const parsed = datevTemplateInputSchema.parse(input);
    const r = await applyDatevTemplate(orgId, parsed.chart, actor, { overwriteEdited: parsed.overwriteEdited });
    refresh();
    return { ok: true, added: r.added, replaced: r.replaced, keptEdited: r.keptEdited, withoutSuggestion: r.withoutSuggestion };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

export async function saveDatevMappingAction(rows: unknown): Promise<DatevActionResult> {
  try {
    const { orgId, actor } = await guard();
    const parsed = datevMappingInputSchema.parse(rows);
    await saveDatevMapping(orgId, parsed, actor);
    refresh();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

const confirmSchema = z
  .object({
    note: datevConfirmNoteSchema,
    acknowledged: z.literal(true, { message: "Bitte bestätigen, dass Konten und Steuerschlüssel mit dem Steuerberater abgestimmt sind." }),
  })
  .strict();

export async function confirmDatevMappingAction(input: unknown): Promise<DatevActionResult> {
  try {
    const { orgId, actor } = await guard();
    const parsed = confirmSchema.parse(input);
    await confirmDatevMapping(orgId, parsed.note, actor);
    refresh();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

export async function previewDatevExportAction(input: unknown): Promise<DatevActionResult<{ preview: PreviewDto }>> {
  try {
    const { orgId } = await guard();
    const parsed = datevExportRequestSchema.parse(input);
    const plan = await planDatevExport(orgId, { from: parsed.from, to: parsed.to, mode: parsed.mode });
    return { ok: true, preview: toPreviewDto(plan) };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

export async function runDatevExportAction(input: unknown): Promise<DatevActionResult<{ export: HistoryRowDto }>> {
  try {
    const { orgId, actor } = await guard();
    const parsed = datevExportRequestSchema.parse(input);
    const view = await runDatevExport(orgId, { from: parsed.from, to: parsed.to, mode: parsed.mode, repeat: parsed.repeat === true }, actor);
    refresh();
    return { ok: true, export: toHistoryRow(view) };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}
