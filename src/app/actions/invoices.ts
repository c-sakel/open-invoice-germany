"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { finalizeInvoice, FinalizeError } from "@/domain/invoice/finalize";
import { ZodError } from "zod";
import { cancelInvoice, CancelError } from "@/domain/invoice/cancel";
import { NotFoundError } from "@/domain/errors";
import { getActiveOrg } from "@/lib/org";
import { parseCancelFormData } from "@/schemas";

export async function finalizeAction(formData: FormData) {
  const id = String(formData.get("id"));
  let errorMessage = "";
  try {
    await finalizeInvoice(id);
  } catch (e) {
    errorMessage = e instanceof FinalizeError ? e.message : "Festschreiben fehlgeschlagen.";
  }
  if (errorMessage) {
    redirect(`/rechnungen/${id}?error=${encodeURIComponent(errorMessage)}`);
  }
  revalidatePath(`/rechnungen/${id}`);
  revalidatePath("/rechnungen");
  redirect(`/rechnungen/${id}`);
}

export async function cancelAction(formData: FormData) {
  let errorMessage = "";
  let creditId = "";
  let sendAfter = false;
  let id = String(formData.get("id") ?? "");
  try {
    const input = parseCancelFormData(formData);
    id = input.id;
    sendAfter = input.sendAfter;
    const org = await getActiveOrg();
    const res = await cancelInvoice(input.id, { orgId: org.id, reason: input.reason, fxOverrideRate: input.fxOverrideRate });
    creditId = res.creditNote.id;
  } catch (e) {
    errorMessage =
      e instanceof CancelError || e instanceof FinalizeError || e instanceof NotFoundError
        ? e.message
        : e instanceof ZodError
          ? `Ungültige Eingabe für das Storno: ${e.issues.map((i) => i.message).join("; ")}`
          : "Storno fehlgeschlagen.";
  }
  if (errorMessage) {
    redirect(`/rechnungen/${id}?error=${encodeURIComponent(errorMessage)}`);
  }
  revalidatePath("/rechnungen");
  revalidatePath(`/rechnungen/${id}`);
  redirect(`/rechnungen/${creditId}${sendAfter ? "?send=1" : ""}`);
}
