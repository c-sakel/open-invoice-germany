/**
 * HTML-Teil fuer Mails, rein aus dem fertigen Text erzeugt (keine Node-/DB-Importe).
 * Quelle: RFC 2046 § 5.1.4 (multipart/alternative: Textteil zuerst, bevorzugte Darstellung zuletzt).
 *
 * Bewusst KEIN Markdown und kein Rohmarkup: Der Text wird vollstaendig escaped, nur sichtbare
 * https:/mailto:-Adressen werden zu Links (Linktext = Ziel, keine verschleierten Ziele).
 * Keine Bilder, Schriften, <style>-Bloecke, Tracking oder externen Ressourcen; Farben nur
 * als geprueftes Hex in Inline-Styles.
 */
import { contrastRatio } from "@/lib/color/contrast";
import { escapeHtml } from "@/lib/richtext/render-html";

export const MAIL_HTML_DEFAULT_COLOR = "#1a1a1a";

export interface MailHtmlOptions {
  accentColor?: string | null;
  lang?: "de" | "en";
  title?: string;
}

/** Gueltiges #rrggbb mit Kontrast >= 4,5 zu Weiss, sonst Standardfarbe. */
export function safeAccentColor(c: string | null | undefined): string {
  if (typeof c !== "string" || !/^#[0-9a-f]{6}$/i.test(c)) return MAIL_HTML_DEFAULT_COLOR;
  return contrastRatio(c, "#ffffff") >= 4.5 ? c.toLowerCase() : MAIL_HTML_DEFAULT_COLOR;
}

/** Steuerzeichen und bidirektionale Umschalter/unsichtbare Zeichen entfernen (Darstellungstricks). */
function stripUnsafe(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g, "");
}

function isAllowedHref(href: string): boolean {
  if (/^mailto:[^\s<>"'@]+@[^\s<>"'@]+$/i.test(href)) return true;
  if (!/^https:\/\//i.test(href)) return false;
  try {
    const u = new URL(href);
    return u.protocol === "https:" && u.hostname.length > 0 && !u.username && !u.password;
  } catch {
    return false;
  }
}

const TRAILING = /[.,;:!?)\]]+$/;

function renderLine(line: string, color: string): string {
  return line
    .split(/(https:\/\/[^\s<>"']+|mailto:[^\s<>"']+)/gi)
    .map((part, i) => {
      if (i % 2 === 0) return escapeHtml(part);
      const trail = TRAILING.exec(part)?.[0] ?? "";
      const href = trail ? part.slice(0, part.length - trail.length) : part;
      if (!isAllowedHref(href)) return escapeHtml(part);
      return `<a href="${escapeHtml(href)}" style="color:${color};text-decoration:underline">${escapeHtml(href)}</a>${escapeHtml(trail)}`;
    })
    .join("");
}

export function renderMailHtml(text: string, opts: MailHtmlOptions = {}): string {
  const color = safeAccentColor(opts.accentColor);
  const lang = opts.lang === "en" ? "en" : "de";
  const title = escapeHtml(stripUnsafe(opts.title ?? "").replace(/[\r\n]+/g, " "));
  const normalized = stripUnsafe(text.replace(/\r\n?/g, "\n")).trim();
  const paragraphs = normalized === "" ? [] : normalized.split(/\n{2,}/);
  const body = paragraphs
    .map((p) => `<p style="margin:0 0 16px 0">${p.split("\n").map((l) => renderLine(l, color)).join("<br>")}</p>`)
    .join("\n");
  return (
    `<!DOCTYPE html><html lang="${lang}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head>` +
    `<body style="margin:0;padding:16px;background:#ffffff">` +
    `<div style="max-width:640px;margin:0 auto;border-top:4px solid ${color};padding-top:16px;` +
    `font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a">\n` +
    `${body}\n</div></body></html>`
  );
}
