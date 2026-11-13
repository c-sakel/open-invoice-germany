import { describe, expect, it } from "vitest";
import { MAIL_HTML_DEFAULT_COLOR, renderMailHtml, safeAccentColor } from "@/lib/mail/html";

const FORBIDDEN = /(src=|url\(|<img|<link|<script|<style|@import|<iframe|<object|<form|http:\/\/)/i;

describe("renderMailHtml", () => {
  it("escaped Script-Tags", () => {
    const h = renderMailHtml("<script>alert(1)</script>");
    expect(h).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(h).not.toContain("<script");
  });
  it("Attribut-Ausbruch erzeugt kein Tag", () => {
    const h = renderMailHtml(`"><img src=x onerror=alert(1)>`);
    expect(h).not.toContain("<img");
    expect(h).not.toMatch(/<[^>]*onerror/i);
  });
  it("verlinkt nur https und mailto", () => {
    for (const t of ["javascript:alert(1)", "http://example.org", "data:text/html,x"]) {
      expect(renderMailHtml(t)).not.toContain("<a ");
    }
    expect(renderMailHtml("mailto:info@example.org")).toContain('href="mailto:info@example.org"');
    expect(renderMailHtml("https://example.org/a")).toContain('href="https://example.org/a"');
  });
  it("kein Markdown", () => {
    const h = renderMailHtml("[Klick](https://evil.example) **fett**");
    expect(h).toContain("**fett**");
    expect(h).toContain("[Klick](");
    expect(h).not.toContain("<strong");
  });
  it("href escaped, Linktext = Ziel", () => {
    const h = renderMailHtml('https://example.org/a?b=1&c="x"');
    expect(h).toContain('href="https://example.org/a?b=1&amp;c=');
    expect(h).toContain("&quot;");
  });
  it("Satzzeichen am Ende ausserhalb des Links", () => {
    const h = renderMailHtml("Siehe https://example.org/x.");
    expect(h).toContain('href="https://example.org/x"');
    expect(h).toContain("</a>.");
  });
  it("Zeilenumbrueche", () => {
    const h = renderMailHtml("a\r\nb\r\n\r\nc");
    expect(h).toContain("a<br>b</p>");
    expect(h.match(/<p /g)).toHaveLength(2);
  });
  it("Farbe", () => {
    expect(renderMailHtml("x", { accentColor: "#0a5c36" })).toContain("#0a5c36");
    for (const c of ["#ffff00", "red;background:url(x)", null, "#12", "#0a5c36;x"]) {
      expect(safeAccentColor(c)).toBe(MAIL_HTML_DEFAULT_COLOR);
      expect(renderMailHtml("x", { accentColor: c })).not.toMatch(/url\(/);
    }
  });
  it("Titel escaped, Sprache", () => {
    const h = renderMailHtml("x", { title: "a<b>\n</title><script>", lang: "en" });
    expect(h).toContain("<title>a&lt;b&gt; &lt;/title&gt;&lt;script&gt;</title>");
    expect(h).toContain('<html lang="en">');
  });
  it("Unicode-Tricks: Bidi-/Steuerzeichen entfernt, Homoglyph-Host nicht als http", () => {
    const h = renderMailHtml("a‮b\u0000c​d https://exa‮mple.org");
    expect(h).not.toMatch(/[‮\u0000​]/);
  });
  it("Zugangsdaten in URL werden nicht verlinkt", () => {
    expect(renderMailHtml("https://user:pw@example.org/")).not.toContain("<a ");
  });
  it("feindliches Korpus und lange Zeilen", () => {
    const corpus = [
      "<script>alert(1)</script>", `"><img src=x onerror=alert(1)>`, "javascript:alert(1)", "http://example.org",
      "data:text/html,x", "<style>@import url(https://x)</style>", "<iframe src=//x></iframe>", "<form action=x>",
      "[Klick](https://evil.example)", "x".repeat(100000), "https://example.org/" + "a".repeat(50000),
    ].join("\n\n");
    const h = renderMailHtml(corpus, { title: corpus, accentColor: "red;background:url(x)" });
    // Escapter Text darf "src=" etc. woertlich enthalten; geprueft wird, was als Markup ausgegeben wird.
    const tags = h.match(/<[^>]*>/g) ?? [];
    expect(tags.join("")).not.toMatch(FORBIDDEN);
    const names = new Set(tags.map((t) => /^<\/?([a-z0-9!]+)/i.exec(t)?.[1]?.toLowerCase()));
    expect([...names].every((n) => ["!doctype", "html", "head", "meta", "title", "body", "div", "p", "br", "a"].includes(n ?? ""))).toBe(true);
    expect(tags.join("")).not.toMatch(/ on[a-z]+=/i);
    expect(renderMailHtml(corpus, { title: corpus, accentColor: "red;background:url(x)" })).toBe(h);
  });
});
