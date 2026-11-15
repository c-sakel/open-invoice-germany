/**
 * Kunde aendern inklusive Debitorennummer. Die Nummer geht ausschliesslich ueber `setCustomerDatevAccount`
 * (Bereich, Eindeutigkeit, Sperre nach dem ersten Export); alle uebrigen Felder wie in `updateCustomer`.
 * Die uebrigen Felder werden vorab geprueft, damit eine Nummer nicht gesetzt wird, wenn sie scheitern.
 */
import { customerFieldsSchema } from "@/schemas";
import { datevAccountInputSchema } from "@/schemas/datev";
import { setCustomerDatevAccount } from "@/domain/export/datev/debtors";
import type { Customer } from "@/generated/prisma/client";
import { updateCustomer } from "./save";

export async function updateCustomerWithDatev(orgId: string, id: string, rawInput: unknown, actor: string): Promise<Customer> {
  const raw = rawInput && typeof rawInput === "object" ? { ...(rawInput as Record<string, unknown>) } : {};
  if (!("datevAccount" in raw)) return updateCustomer(orgId, id, raw);
  const account = datevAccountInputSchema.parse(raw.datevAccount);
  delete raw.datevAccount;
  customerFieldsSchema.partial().parse(raw);
  await setCustomerDatevAccount(orgId, id, account, actor);
  return updateCustomer(orgId, id, raw);
}
