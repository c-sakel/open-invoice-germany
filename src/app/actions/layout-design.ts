"use server";

/**
 * Server Actions des Layout-Designers (Phase 16g). Die Validierung liegt ausschliesslich in der
 * Domain (`saveLayoutDesign`/`archiveLayoutDesign`, Zod + DIN-5008-Fenster); hier nur Org-
 * Aufloesung und die Uebersetzung der Fehlerklassen in Meldungen mit Feldpfad.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getActiveOrg } from "@/lib/org";
import { InvalidOperationError, NotFoundError, ValidationError } from "@/domain/errors";
import { archiveLayoutDesign, saveLayoutDesign } from "@/domain/layout-design/save";

export interface LayoutDesignActionIssue {
  path: string;
  message: string;
}

export type LayoutDesignActionResult =
  | { ok: true; id: string; name: string; currentVersion: number; archived: boolean }
  | { ok: false; error: string; issues?: LayoutDesignActionIssue[] };

function failure(e: unknown, label: string): LayoutDesignActionResult {
  if (e instanceof z.ZodError) {
    const issues = e.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return { ok: false, error: issues[0]?.message ?? "Ungültige Eingabe.", issues };
  }
  if (e instanceof ValidationError || e instanceof InvalidOperationError || e instanceof NotFoundError) {
    return { ok: false, error: e.message };
  }
  console.error(`${label}:`, e);
  return { ok: false, error: "Speichern fehlgeschlagen." };
}

export async function saveLayoutDesignAction(input: unknown): Promise<LayoutDesignActionResult> {
  try {
    const org = await getActiveOrg();
    const design = await saveLayoutDesign(org.id, input, "user");
    revalidatePath("/einstellungen/briefpapier");
    return { ok: true, id: design.id, name: design.name, currentVersion: design.currentVersion, archived: design.archived };
  } catch (e) {
    return failure(e, "saveLayoutDesignAction");
  }
}

export async function archiveLayoutDesignAction(id: string, archived: boolean): Promise<LayoutDesignActionResult> {
  try {
    const org = await getActiveOrg();
    const design = await archiveLayoutDesign(org.id, z.string().min(1).parse(id), archived, "user");
    revalidatePath("/einstellungen/briefpapier");
    return { ok: true, id: design.id, name: design.name, currentVersion: design.currentVersion, archived: design.archived };
  } catch (e) {
    return failure(e, "archiveLayoutDesignAction");
  }
}
