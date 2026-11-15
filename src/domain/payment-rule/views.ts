/** Lesedaten der Belegansicht: Regel-Laeufe je Zahlung einer Rechnung (nur eigene Organisation, ohne Fehlertexte). */
import { dbInternal } from "@/lib/db";

export interface InvoicePaymentRuleRun {
  paymentId: string;
  ruleName: string;
  status: string;
}

export async function listInvoicePaymentRuleRuns(orgId: string, invoiceId: string): Promise<InvoicePaymentRuleRun[]> {
  const rows = await dbInternal.paymentRuleRun.findMany({
    where: { orgId, invoiceId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 200,
    select: { paymentId: true, status: true, rule: { select: { name: true } } },
  });
  return rows.map((r) => ({ paymentId: r.paymentId, ruleName: r.rule.name, status: r.status }));
}
