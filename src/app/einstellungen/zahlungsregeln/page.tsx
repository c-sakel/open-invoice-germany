import { getActiveOrg } from "@/lib/org";
import { dbInternal } from "@/lib/db";
import { SettingsTabs } from "@/components/SettingsTabs";
import { listPaymentRules } from "@/domain/payment-rule/rules";
import { listPaymentRuleRuns } from "@/domain/payment-rule/runs";
import { listTags } from "@/domain/tag/manage";
import { PaymentRuleList } from "@/components/payment-rules/PaymentRuleList";
import { PaymentRuleRunsTable } from "@/components/payment-rules/PaymentRuleRunsTable";
import { PAYMENT_CONFIRMATION_TEMPLATE_TYPE } from "@/components/payment-rules/rule-form-model";

export const dynamic = "force-dynamic";

export default async function PaymentRulesPage() {
  const org = await getActiveOrg();
  const [rules, tags, templates, runList] = await Promise.all([
    listPaymentRules(org.id),
    listTags(org.id),
    dbInternal.emailTemplate.findMany({
      where: { orgId: org.id, docType: PAYMENT_CONFIRMATION_TEMPLATE_TYPE },
      orderBy: { name: "asc" },
      select: { id: true, name: true, docType: true },
    }),
    listPaymentRuleRuns(org.id, { limit: 50 }),
  ]);
  const invoices = await dbInternal.invoice.findMany({
    where: { orgId: org.id, id: { in: [...new Set(runList.rows.map((r) => r.invoiceId))] } },
    select: { id: true, number: true },
  });
  const numbers = new Map(invoices.map((i) => [i.id, i.number]));

  return (
    <div className="space-y-6">
      <SettingsTabs active="zahlungsregeln" />
      <h1 className="text-2xl font-bold tracking-tight">Nach Zahlungseingang</h1>
      <p className="max-w-3xl text-sm text-ink-soft">
        Regeln lösen nach einer erfassten Zahlung Aktionen aus: Bestätigungsmail, Tag, Benachrichtigung, Webhook oder das Fortsetzen pausierter Abos.
        Es gibt keine Standardregel. Die Ausführung erfolgt nach der Wartezeit mit dem nächsten Scheduler-Lauf; bereits ausgeführte Aktionen werden bei einer Gegenbuchung nicht zurückgenommen.
      </p>
      <PaymentRuleList
        rules={rules.map((r) => ({
          id: r.id, name: r.name, active: r.active, trigger: r.trigger, sources: r.sources, invoiceTagId: r.invoiceTagId,
          delayMinutes: r.delayMinutes, actions: r.actions, sortOrder: r.sortOrder, tagMissing: r.tagMissing, broken: r.broken,
        }))}
        tags={tags.map((t) => ({ id: t.id, name: t.name }))}
        templates={templates}
      />
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Protokoll (letzte 50 Läufe)</h2>
        <PaymentRuleRunsTable
          runs={runList.rows.map((r) => ({
            id: r.id, createdAt: r.createdAt.toISOString(), invoiceId: r.invoiceId, invoiceNumber: numbers.get(r.invoiceId) ?? null,
            ruleName: r.ruleName, status: r.status, steps: r.steps, lastError: r.lastError, skipReason: r.skipReason,
          }))}
        />
      </section>
    </div>
  );
}
