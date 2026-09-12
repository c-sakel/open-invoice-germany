"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getActiveOrg } from "@/lib/org";
import { upsertBaseRate, deleteBaseRate } from "@/domain/dunning/base-rate";
import { ValidationError, NotFoundError } from "@/domain/errors";
import type { ActionResult } from "./result";

function str(fd: FormData, key: string): string | undefined {
  const v = fd.get(key);
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? undefined : s;
}

function firstError(issues: { message: string }[]): string {
  return issues[0]?.message ?? "Ungültige Eingabe";
}

/**
 * Legt einen Basiszinssatz an oder überschreibt den bestehenden Eintrag zum selben
 * `validFrom` (Upsert, § 288 Abs. 1 Satz 2 BGB, Task 4/R6) — dieselbe Domain-Funktion wie
 * `POST /api/v1/BaseInterestRate` und das MCP-Werkzeug `set_base_interest_rate`.
 * Eingabe im Formular in Prozent (z. B. "1,27"), intern Basispunkte (127).
 */
export async function upsertBaseRateAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const validFrom = str(fd, "validFrom");
  const ratePercentRaw = str(fd, "ratePercent");
  const source = str(fd, "source") ?? null;

  if (!validFrom) return { ok: false, error: "Datum (gültig ab) ist erforderlich." };
  if (!ratePercentRaw) return { ok: false, error: "Basiszinssatz ist erforderlich." };
  const ratePercent = Number(ratePercentRaw.replace(",", "."));
  if (!Number.isFinite(ratePercent)) return { ok: false, error: "Basiszinssatz muss eine Zahl sein." };
  const rateBp = Math.round(ratePercent * 100);

  try {
    const org = await getActiveOrg();
    await upsertBaseRate(org.id, { validFrom, rateBp, source });
  } catch (e) {
    if (e instanceof z.ZodError) return { ok: false, error: firstError(e.issues) };
    if (e instanceof ValidationError) return { ok: false, error: e.message };
    console.error("upsertBaseRateAction:", e);
    return { ok: false, error: "Speichern fehlgeschlagen." };
  }
  revalidatePath("/einstellungen/mahnwesen");
  return { ok: true };
}

/** Löscht einen Basiszinssatz-Eintrag — nicht den letzten verbleibenden (siehe deleteBaseRate). */
export async function deleteBaseRateAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const id = str(fd, "id");
  if (!id) return { ok: false, error: "Basiszinssatz nicht gefunden." };

  try {
    const org = await getActiveOrg();
    await deleteBaseRate(org.id, id);
  } catch (e) {
    if (e instanceof NotFoundError) return { ok: false, error: e.message };
    if (e instanceof ValidationError) return { ok: false, error: e.message };
    console.error("deleteBaseRateAction:", e);
    return { ok: false, error: "Löschen fehlgeschlagen." };
  }
  revalidatePath("/einstellungen/mahnwesen");
  return { ok: true };
}
