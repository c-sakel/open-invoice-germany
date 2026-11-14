"use client";

import { renderMailHtml } from "@/lib/mail/html";

const SAMPLE_TEXT = [
  "Guten Tag Frau Beispiel,",
  "",
  "anbei erhalten Sie die Rechnung RE-0001 über 119,00 €. Die Online-Ansicht finden Sie unter https://example.org/rechnung/abc.",
  "",
  "Mit freundlichen Grüßen",
  "Musterfirma GmbH",
].join("\n");

/** Vorschau: Text- und HTML-Version mit fiktivem Beispieltext; das HTML laeuft in einem Sandbox-iframe ohne jede Berechtigung (keine Skripte). */
export function MailHtmlPreview({ primaryColor }: { primaryColor: string | null }) {
  const html = renderMailHtml(SAMPLE_TEXT, { accentColor: primaryColor, title: "Vorschau" });
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div>
        <p className="mb-1 text-xs font-medium text-ink-soft">Textversion</p>
        <pre className="h-64 overflow-auto whitespace-pre-wrap rounded-[var(--radius-control)] border border-rule bg-paper p-3 text-xs text-ink">{SAMPLE_TEXT}</pre>
      </div>
      <div>
        <p className="mb-1 text-xs font-medium text-ink-soft">HTML-Version</p>
        <iframe sandbox="" srcDoc={html} title="HTML-Vorschau" className="h-64 w-full rounded-[var(--radius-control)] border border-rule bg-white" />
      </div>
    </div>
  );
}
