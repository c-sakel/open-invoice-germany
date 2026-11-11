import Link from "next/link";
import { getActiveOrg } from "@/lib/org";
import { dbInternal } from "@/lib/db";
import { SettingsTabs } from "@/components/SettingsTabs";
import { DOC_TYPE_LABEL } from "@/lib/email/doc-type-labels";
import { TextTemplateRowActions } from "@/components/forms/TextTemplateRowActions";
import { LanguageFilter } from "@/components/forms/LanguageFilter";
import { DOC_LANGUAGES, DOC_LANGUAGE_LABEL, type DocLanguage } from "@/lib/i18n/doc";
import type { EmailDocType } from "@/schemas/email";

export const dynamic = "force-dynamic";

const DOC_TYPES: EmailDocType[] = ["ANGEBOT", "AUFTRAGSBESTAETIGUNG", "PROFORMA", "DELIVERY_NOTE", "INVOICE"];
const POSITION_LABEL: Record<string, string> = {
  HEAD: "Kopftext",
  FOOT: "Fußtext",
  TERMS_DELIVERY: "Lieferbedingungen",
  TERMS_PAYMENT: "Zahlungsbedingungen",
};

export default async function TextTemplatesPage({ searchParams }: { searchParams: Promise<{ sprache?: string }> }) {
  const org = await getActiveOrg();
  const { sprache } = await searchParams;
  const language = DOC_LANGUAGES.find((l) => l === sprache);
  const templates = await dbInternal.textTemplate.findMany({
    where: { orgId: org.id, ...(language ? { language } : {}) },
    orderBy: [{ docType: "asc" }, { position: "asc" }, { name: "asc" }],
  });

  const byCombo = new Map<string, typeof templates>();
  for (const t of templates) {
    const key = `${t.docType}|${t.position}`;
    byCombo.set(key, [...(byCombo.get(key) ?? []), t]);
  }

  return (
    <div className="space-y-6">
      <SettingsTabs active="textvorlagen" />
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Dokumenttexte</h1>
        <Link href="/einstellungen/textvorlagen/neu" className="rounded-md bg-pen px-4 py-2 text-sm font-medium text-on-accent hover:bg-pen-strong">
          Neue Vorlage
        </Link>
      </div>
      <p className="text-sm text-ink-muted">
        Kopf-/Fußtext und Bedingungen, die beim Anlegen eines Belegs als Standard eingesetzt werden. Der Text wird als Snapshot am Beleg
        gespeichert — spätere Änderungen an der Vorlage wirken sich nur auf neue Belege aus.
      </p>

      <LanguageFilter active={language} />

      {DOC_TYPES.map((docType) => {
        const positions = Object.keys(POSITION_LABEL).filter((p) => (byCombo.get(`${docType}|${p}`) ?? []).length > 0);
        if (positions.length === 0) return null;
        return (
          <section key={docType} className="space-y-3 rounded-[var(--radius-card)] border border-rule bg-sheet p-5">
            <h2 className="font-semibold text-ink">{DOC_TYPE_LABEL[docType]}</h2>
            {positions.map((position) => {
              const items = byCombo.get(`${docType}|${position}`) ?? [];
              return (
                <div key={position} className="space-y-1">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{POSITION_LABEL[position]}</h3>
                  <div className="divide-y divide-rule">
                    {items.map((t) => (
                      <div key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-ink">{t.name}</span>
                          <span className="rounded bg-well px-1.5 py-0.5 text-xs font-medium text-ink-soft">{DOC_LANGUAGE_LABEL[(t.language === "en" ? "en" : "de") as DocLanguage]}</span>
                          {t.isDefault && <span className="rounded bg-ledger/10 px-1.5 py-0.5 text-xs font-medium text-ledger">Standard</span>}
                        </div>
                        <div className="flex items-center gap-3">
                          <Link href={`/einstellungen/textvorlagen/${t.id}`} className="text-pen hover:underline">
                            Bearbeiten
                          </Link>
                          <TextTemplateRowActions id={t.id} isDefault={t.isDefault} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </section>
        );
      })}

      {templates.length === 0 && (
        <div className="rounded-[var(--radius-card)] border border-dashed border-rule-strong bg-sheet p-10 text-center text-ink-muted">
          Noch keine Dokumenttexte.{" "}
          <Link href="/einstellungen/textvorlagen/neu" className="font-medium text-pen hover:underline">
            Lege die erste Vorlage an.
          </Link>
        </div>
      )}
    </div>
  );
}
