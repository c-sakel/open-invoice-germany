/**
 * HTML-Teil fuer ausgehende Mails (Phase 18c): haengt, wenn in den Mail-Einstellungen aktiviert,
 * einen aus dem fertigen Text erzeugten HTML-Teil an. Der Text bleibt unveraendert; es gibt
 * keine weitere Quelle fuer den HTML-Inhalt als `mail.text`. Wirft nie: Schlaegt das Rendern
 * fehl, geht die Mail unveraendert (nur Text) hinaus, ohne Inhalt im Log.
 */
import { loadBrandingSettings } from "@/domain/settings/branding";
import { renderMailHtml } from "@/lib/mail/html";
import type { OutgoingMail } from "@/lib/mail/provider";

export async function withHtmlPart(
  orgId: string,
  settings: { htmlEnabled: boolean },
  mail: OutgoingMail,
  opts: { lang?: "de" | "en" } = {},
): Promise<OutgoingMail> {
  if (!settings.htmlEnabled) return mail;
  let accentColor: string | null = null;
  try {
    accentColor = (await loadBrandingSettings(orgId)).primaryColor;
  } catch {
    console.warn("withHtmlPart: Branding nicht ladbar, Standardfarbe");
  }
  try {
    return { ...mail, html: renderMailHtml(mail.text, { accentColor, title: mail.subject, lang: opts.lang }) };
  } catch {
    console.warn("withHtmlPart: HTML-Teil nicht erzeugt, Mail nur als Text");
    return mail;
  }
}
