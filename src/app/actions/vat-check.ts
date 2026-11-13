"use server";

/**
 * Server Action: USt-IdNr. eines Kunden ueber VIES pruefen (Phase 17a) — dieselbe
 * Domain-Funktion wie POST /api/v1/Contact/{id}/vat-check und das MCP-Tool check_vat_id.
 */
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getActiveOrg } from "@/lib/org";
import { checkVatId, VatCheckDisabledError, VatCheckRateLimitError } from "@/domain/customer/vat-check";
import { CustomerValidationError } from "@/domain/customer/save";
import { NotFoundError } from "@/domain/errors";

export interface VatCheckActionResult {
  ok: boolean;
  error?: string;
  status?: "VALID" | "INVALID" | "ERROR";
}

const customerIdSchema = z.string().min(1);

export async function checkVatIdAction(customerId: string): Promise<VatCheckActionResult> {
  const parsed = customerIdSchema.safeParse(customerId);
  if (!parsed.success) return { ok: false, error: "Ungültiger Kunde." };
  try {
    const org = await getActiveOrg();
    const row = await checkVatId(org.id, parsed.data, { trigger: "MANUAL" });
    revalidatePath(`/kunden/${parsed.data}`);
    return { ok: true, status: row.status };
  } catch (e) {
    if (
      e instanceof NotFoundError ||
      e instanceof VatCheckDisabledError ||
      e instanceof VatCheckRateLimitError ||
      e instanceof CustomerValidationError
    ) {
      return { ok: false, error: e.message };
    }
    console.error("checkVatIdAction:", e);
    return { ok: false, error: "Prüfung fehlgeschlagen." };
  }
}
