/** Debitorennummern (Personenkonten): Vergabe beim Lauf, manuelle Pflege mit Sperre nach dem ersten Export. */
import { dbInternal } from "@/lib/db";
import { lockOrganization } from "@/lib/db-lock";
import type { Prisma } from "@/generated/prisma/client";
import { logActivity } from "@/domain/activity/log";
import { DatevError } from "./errors";
import { accountRules, getDatevSettings, type DatevSettingsView } from "./settings";

type Tx = Prisma.TransactionClient;

/**
 * Setzt oder loescht (null) die Debitorennummer eines Kunden. Einzige Schreibstelle fuer `Customer.datevAccount`
 * (Oberflaeche, REST, MCP; Kundenformulare und CSV-Import kennen das Feld nicht). Gesperrt, sobald ein
 * Exportposten zu diesem Kunden existiert; Bereich und Eindeutigkeit werden geprueft.
 */
export async function setCustomerDatevAccount(orgId: string, customerId: string, account: number | null, actor: string): Promise<void> {
  await dbInternal.$transaction((tx) => setCustomerDatevAccountWithinTx(tx, orgId, customerId, account, actor));
}

/** Wie `setCustomerDatevAccount`, in der Transaktion des Aufrufers (nimmt die Organisationssperre selbst). */
export async function setCustomerDatevAccountWithinTx(tx: Tx, orgId: string, customerId: string, account: number | null, actor: string): Promise<void> {
  if (account !== null && (!Number.isInteger(account) || account < 1)) throw new DatevError("VALIDATION", "Debitorennummer: ganze Zahl ab 1.");
  await lockOrganization(tx, orgId);
  const customer = await tx.customer.findFirst({ where: { id: customerId, orgId }, select: { id: true, datevAccount: true } });
  if (!customer) throw new DatevError("NOT_FOUND", "Kunde nicht gefunden.");
  if (customer.datevAccount === account) return;
  const used = await tx.datevExportItem.findFirst({ where: { orgId, customerId }, select: { id: true } });
  if (used) throw new DatevError("DEBTOR_LOCKED", "Die Debitorennummer ist nach dem ersten Export gesperrt.");
  if (account !== null) {
    const settings = await getDatevSettings(orgId, tx);
    const { debtorMin, debtorMax } = accountRules(settings.accountLength);
    if (account < debtorMin || account > debtorMax) {
      throw new DatevError("ACCOUNT_OUT_OF_RANGE", `Debitorennummer muss zwischen ${debtorMin} und ${debtorMax} liegen.`);
    }
    const clash = await tx.customer.findFirst({ where: { orgId, datevAccount: account, NOT: { id: customerId } }, select: { id: true } });
    if (clash) throw new DatevError("DEBTOR_DUPLICATE", "Die Debitorennummer ist bereits vergeben.");
  }
  await tx.customer.update({ where: { id: customerId }, data: { datevAccount: account }, select: { id: true } });
  await logActivity(tx, { orgId, entityType: "CUSTOMER", entityId: customerId, type: "DATEV_DEBTOR_ACCOUNT_SET", actor, data: { cleared: account === null } });
}

function compareNumbers(a: string | null, b: string | null): number {
  return (a ?? "").localeCompare(b ?? "", "de", { numeric: true });
}

/**
 * Liefert je Kunde das Debitorenkonto. PERSONAL: fehlende Nummern werden fortlaufend vergeben
 * (`max(vorhandene, Start-1)+1`, Reihenfolge Kundennummer, dann Anlage, dann Id); Ueberlauf -> DEBTOR_RANGE_EXHAUSTED.
 * COLLECTIVE: alle Kunden auf das Sammelkonto, keine Vergabe. In der Transaktion des Laufs aufrufen
 * (Organisationssperre haelt der Aufrufer).
 */
export async function assignDebtorAccountsWithinTx(
  tx: Tx,
  orgId: string,
  customerIds: readonly string[],
  settings: DatevSettingsView,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (settings.debtorMode === "COLLECTIVE") {
    if (settings.collectiveDebtorAccount === null) throw new DatevError("SETTINGS_INCOMPLETE", "Sammeldebitor fehlt.");
    for (const id of customerIds) result.set(id, settings.collectiveDebtorAccount);
    return result;
  }
  const { debtorMin, debtorMax } = accountRules(settings.accountLength);
  const unique = [...new Set(customerIds)];
  const customers = await tx.customer.findMany({
    where: { orgId, id: { in: unique } },
    select: { id: true, customerNumber: true, createdAt: true, datevAccount: true },
  });
  const missing = customers
    .filter((c) => c.datevAccount === null)
    .sort((a, b) => compareNumbers(a.customerNumber, b.customerNumber) || a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
  for (const c of customers) if (c.datevAccount !== null) result.set(c.id, c.datevAccount);
  if (missing.length > 0) {
    const top = await tx.customer.aggregate({ where: { orgId, datevAccount: { not: null } }, _max: { datevAccount: true } });
    let next = Math.max(top._max.datevAccount ?? 0, (settings.debtorRangeStart ?? debtorMin) - 1) + 1;
    if (next < debtorMin) next = debtorMin;
    for (const c of missing) {
      if (next > debtorMax) throw new DatevError("DEBTOR_RANGE_EXHAUSTED", `Der Debitorenbereich bis ${debtorMax} ist erschoepft.`);
      await tx.customer.update({ where: { id: c.id }, data: { datevAccount: next }, select: { id: true } });
      result.set(c.id, next);
      next += 1;
    }
  }
  return result;
}
