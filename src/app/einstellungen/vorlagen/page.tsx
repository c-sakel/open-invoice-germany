import Link from "next/link";
import { getActiveOrg } from "@/lib/org";
import { dbInternal } from "@/lib/db";
import { SettingsTabs } from "@/components/SettingsTabs";
import { DOC_TYPE_LABEL } from "@/lib/email/doc-type-labels";
import { EMAIL_DOC_TYPES, type EmailDocType } from "@/schemas/email";
import { TemplateRowActions } from "@/components/forms/TemplateRowActions";
import { LanguageFilter } from "@/components/forms/LanguageFilter";
import { DOC_LANGUAGES, DOC_LANGUAGE_LABEL, type DocLanguage } from "@/lib/i18n/doc";

export const dynamic = "force-dynamic";

export default async function EmailTemplatesPage({ searchParams }: { searchParams: Promise<{ sprache?: string }> }) {
  const org = await getActiveOrg();
  const { sprache } = await searchParams;
  const language = DOC_LANGUAGES.find((l) => l === sprache);
  const templates = await dbInternal.emailTemplate.findMany({
    where: { orgId: org.id, ...(language ? { language } : {}) },
    orderBy: [{ docType: "asc" }, { name: "asc" }],
  });

  const byDocType = new Map<EmailDocType, typeof templates>();
  for (const t of templates) {
    const key = t.docType as EmailDocType;
    byDocType.set(key, [...(byDocType.get(key) ?? []), t]);
  }

  return (
    <div className="space-y-6">
      <SettingsTabs active="vorlagen" />
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Textvorlagen</h1>
        <Link href="/einstellungen/vorlagen/neu" className="rounded-md bg-pen px-4 py-2 text-sm font-medium text-on-accent hover:bg-pen-strong">
          Neue Vorlage
        </Link>
      </div>

      <LanguageFilter active={language} />

      {EMAIL_DOC_TYPES.map((docType) => {
        const items = byDocType.get(docType) ?? [];
        if (items.length === 0) return null;
        return (
          <section key={docType} className="space-y-2 rounded-[var(--radius-card)] border border-rule bg-sheet p-5">
            <h2 className="font-semibold text-ink">{DOC_TYPE_LABEL[docType]}</h2>
            <div className="divide-y divide-rule">
              {items.map((t) => (
                <div key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-ink">{t.name}</span>
                    <span className="rounded bg-well px-1.5 py-0.5 text-xs font-medium text-ink-soft">{DOC_LANGUAGE_LABEL[(t.language === "en" ? "en" : "de") as DocLanguage]}</span>
                    {t.isDefault && <span className="rounded bg-ledger/10 px-1.5 py-0.5 text-xs font-medium text-ledger">Standard</span>}
                    {t.isSystem && <span className="rounded bg-well px-1.5 py-0.5 text-xs font-medium text-ink-soft">System</span>}
                  </div>
                  <div className="flex items-center gap-3">
                    <Link href={`/einstellungen/vorlagen/${t.id}`} className="text-pen hover:underline">
                      Bearbeiten
                    </Link>
                    <TemplateRowActions id={t.id} isDefault={t.isDefault} />
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
