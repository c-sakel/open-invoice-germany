import { PageHeader } from "@/components/PageHeader";
import { getActiveOrg } from "@/lib/org";
import { dbInternal } from "@/lib/db";
import { listTemplates } from "@/domain/template/list";
import { TemplateManager, type TemplateManagerItem } from "@/components/templates/TemplateManager";

export const dynamic = "force-dynamic";

/**
 * Vorlagenuebersicht (Phase 13d, Task 4) — Belegvorlagen ueber alle drei Belegarten
 * (INVOICE/QUOTE/DELIVERY_NOTE, src/domain/template/list.ts#listTemplates). Kundennamen
 * werden in EINEM Bulk-Query fuer die ganze Seite aufgeloest (kein N+1) — `customerId` ist
 * bewusst kein FK (Kunde darf geloescht/archiviert sein, siehe prisma/schema.prisma),
 * ein fehlender Treffer zeigt dann "—" statt eines Fehlers.
 */
export default async function VorlagenPage() {
  const org = await getActiveOrg();
  const templates = await listTemplates(org.id);

  const customerIds = [...new Set(templates.map((t) => t.customerId).filter((id): id is string => id != null))];
  const customers = customerIds.length
    ? await dbInternal.customer.findMany({ where: { orgId: org.id, id: { in: customerIds } }, select: { id: true, name: true } })
    : [];
  const customerNameById = new Map(customers.map((c) => [c.id, c.name]));

  const items: TemplateManagerItem[] = templates.map((t) => ({
    id: t.id,
    name: t.name,
    docType: t.docType,
    kind: t.kind,
    customerName: t.customerId ? (customerNameById.get(t.customerId) ?? null) : null,
    usageCount: t.usageCount,
    lastUsedAt: t.lastUsedAt,
  }));

  return (
    <div className="space-y-6">
      <PageHeader title="Vorlagen" subtitle={`${templates.length} ${templates.length === 1 ? "Vorlage" : "Vorlagen"}`} />
      <p className="text-sm text-slate-500">
        Wiederverwendbare Positionen und Kopf-Metadaten eines Belegs — über „Als Vorlage speichern“ im Beleg-Menü angelegt, hier zu einem neuen
        Entwurf verarbeitet.
      </p>
      <TemplateManager templates={items} />
    </div>
  );
}
