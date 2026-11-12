import Link from "next/link";
import { notFound } from "next/navigation";
import { dbInternal } from "@/lib/db";
import { getActiveOrg } from "@/lib/org";
import { NotFoundError } from "@/domain/errors";
import { getLayoutDesign, listLayoutDesigns, listLayoutDesignVersions } from "@/domain/layout-design/list";
import { listLayouts } from "@/lib/pdf/layouts/registry";
import { presetConfig } from "@/lib/pdf/layouts/presets";
import { SettingsTabs } from "@/components/SettingsTabs";
import { PageHeader } from "@/components/PageHeader";
import { BriefpapierTabs } from "@/components/settings/BriefpapierTabs";
import { buttonClass } from "@/components/ui/Button";
import { LayoutDesigner } from "@/components/settings/layout-designer/LayoutDesigner";

export const dynamic = "force-dynamic";

const dateFormat = new Intl.DateTimeFormat("de-DE", { dateStyle: "short" });

/** Designer fuer versionierte PDF-Layout-Designs (Phase 16g); `?id=` waehlt ein Design, ohne `id` startet ein neues. */
export default async function LayoutDesignerPage({ searchParams }: { searchParams: Promise<{ id?: string; from?: string }> }) {
  const { id, from } = await searchParams;
  const org = await getActiveOrg();
  const [designs, drafts] = await Promise.all([
    listLayoutDesigns(org.id, { includeArchived: true }),
    dbInternal.invoice.findMany({
      where: { orgId: org.id, status: "DRAFT" },
      select: { id: true, type: true, createdAt: true, customer: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);
  const presets = listLayouts().map((l) => ({ id: l.id, name: l.name, config: presetConfig(l.id) }));

  let current: Awaited<ReturnType<typeof getLayoutDesign>> | null = null;
  if (id) {
    try {
      current = await getLayoutDesign(org.id, id);
    } catch (e) {
      if (e instanceof NotFoundError) notFound();
      throw e;
    }
  }
  const versions = current ? await listLayoutDesignVersions(org.id, current.id) : [];
  const startPreset = presets.find((p) => p.id === from)?.id ?? "standard";

  return (
    <div className="space-y-6">
      <SettingsTabs active="briefpapier" />
      <PageHeader title="Briefpapier" subtitle="Eigene PDF-Layouts mit Blockreihenfolge, Spalten, Schrift und Farben." />
      <BriefpapierTabs active="designer" />
      <nav aria-label="Designs" className="flex flex-wrap items-center gap-2 text-sm">
        {designs.map((d) => (
          <Link
            key={d.id}
            href={`/einstellungen/briefpapier/designer?id=${d.id}`}
            className={`rounded-full px-3 py-1 ring-1 ring-inset ${d.id === current?.id ? "bg-pen text-on-accent ring-pen" : "text-ink-soft ring-rule-strong hover:bg-well"}`}
          >
            {d.name}
            {d.archived ? " (archiviert)" : ""}
          </Link>
        ))}
        <Link href="/einstellungen/briefpapier/designer" className={buttonClass("secondary", "sm")}>
          + Neues Design
        </Link>
      </nav>
      <LayoutDesigner
        key={current ? `${current.id}-${current.currentVersion}` : `new-${startPreset}`}
        design={
          current
            ? { id: current.id, name: current.name, baseLayoutId: current.baseLayoutId, currentVersion: current.currentVersion, archived: current.archived }
            : null
        }
        initialConfig={current ? current.config : presetConfig(startPreset)}
        presets={presets}
        versions={versions.map((v) => ({ id: v.id, version: v.version, createdAt: v.createdAt.toISOString() }))}
        drafts={drafts.map((d) => ({
          id: d.id,
          label: `${d.type === "CREDIT_NOTE" ? "Gutschrift" : "Rechnung"}-Entwurf vom ${dateFormat.format(d.createdAt)} – ${d.customer.name}`,
        }))}
      />
    </div>
  );
}
