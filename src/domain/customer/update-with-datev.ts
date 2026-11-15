/**
 * Kunde aendern inklusive Debitorennummer. Die Nummer geht ausschliesslich ueber `setCustomerDatevAccountWithinTx`
 * (Bereich, Eindeutigkeit, Sperre nach dem ersten Export); alle uebrigen Felder wie in `updateCustomer`.
 * Nummer und uebrige Felder laufen in EINER Transaktion: scheitert eines, wird nichts geschrieben.
 */
import { dbInternal } from "@/lib/db";
import { datevAccountInputSchema } from "@/schemas/datev";
import { setCustomerDatevAccountWithinTx } from "@/domain/export/datev/debtors";
import type { Customer } from "@/generated/prisma/client";
import { updateCustomer } from "./save";

export async function updateCustomerWithDatev(orgId: string, id: string, rawInput: unknown, actor: string): Promise<Customer> {
  const raw = rawInput && typeof rawInput === "object" ? { ...(rawInput as Record<string, unknown>) } : {};
  if (raw.datevAccount === undefined) {
    delete raw.datevAccount;
    return updateCustomer(orgId, id, raw);
  }
  const account = datevAccountInputSchema.parse(raw.datevAccount);
  delete raw.datevAccount;
  return dbInternal.$transaction(async (tx) => {
    await setCustomerDatevAccountWithinTx(tx, orgId, id, account, actor);
    return updateCustomer(orgId, id, raw, tx);
  });
}
