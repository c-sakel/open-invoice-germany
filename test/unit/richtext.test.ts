import { describe, it, expect } from "vitest";
import PDFDocument from "pdfkit";
import { parseRichText, renderRichTextHtml, renderRichTextPdf, plainText } from "@/lib/richtext";

describe("parseRichText / renderRichTextHtml — Escaping (§9)", () => {
  it("HTML-Sonderzeichen und <script> bleiben Text, kein rohes HTML", () => {
    const blocks = parseRichText("Vorsicht <script>alert(1)</script> & \"Zitat\"");
    const html = renderRichTextHtml(blocks);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;Zitat&quot;");
  });
});

describe("parseRichText — Links", () => {
  it("erlaubt https:// und mailto: Links", () => {
    const blocks = parseRichText("[Website](https://example.com) und [Mail](mailto:info@example.com)");
    const html = renderRichTextHtml(blocks);
    expect(html).toContain('<a href="https://example.com" rel="noopener noreferrer" target="_blank">Website</a>');
    expect(html).toContain('<a href="mailto:info@example.com" rel="noopener noreferrer" target="_blank">Mail</a>');
  });

  it("verbotene Schemata (javascript:, data:, relativ, http:) werden zu Klartext", () => {
    const inputs = [
      "[Klick](javascript:alert(1))",
      "[Bild](data:text/html;base64,xxx)",
      "[Relativ](/pfad)",
      "[Unsicher](http://example.com)",
    ];
    for (const input of inputs) {
      const blocks = parseRichText(input);
      const html = renderRichTextHtml(blocks);
      expect(html).not.toContain("<a ");
      expect(html).not.toContain("javascript:");
      expect(html).not.toContain("data:");
    }
  });
});

describe("parseRichText — verschachtelte Formatierung", () => {
  it("**fett _und kursiv_** ergibt einen fett+kursiv-Run", () => {
    const blocks = parseRichText("**fett _und kursiv_** normal");
    expect(blocks).toEqual([
      {
        type: "paragraph",
        runs: [
          { text: "fett ", bold: true },
          { text: "und kursiv", bold: true, italic: true },
          { text: " normal" },
        ],
      },
    ]);
  });

  it("__unterstrichen__ wird als eigenes Flag erkannt", () => {
    const blocks = parseRichText("__wichtig__");
    expect(blocks).toEqual([{ type: "paragraph", runs: [{ text: "wichtig", underline: true }] }]);
  });

  it("HTML-Rendering verschachtelter Formatierung erzeugt korrekt genestete Tags", () => {
    const blocks = parseRichText("**fett _und kursiv_**");
    const html = renderRichTextHtml(blocks);
    expect(html).toBe("<p><strong>fett </strong><strong><em>und kursiv</em></strong></p>");
  });
});

describe("parseRichText — Listen", () => {
  it("ungeordnete Liste (\"- \")", () => {
    const blocks = parseRichText("- Erstens\n- Zweitens");
    expect(blocks).toEqual([
      {
        type: "list",
        ordered: false,
        items: [[{ text: "Erstens" }], [{ text: "Zweitens" }]],
      },
    ]);
    expect(renderRichTextHtml(blocks)).toBe("<ul><li>Erstens</li><li>Zweitens</li></ul>");
  });

  it("geordnete Liste (\"1. \")", () => {
    const blocks = parseRichText("1. Erstens\n2. Zweitens");
    expect(blocks).toEqual([
      {
        type: "list",
        ordered: true,
        items: [[{ text: "Erstens" }], [{ text: "Zweitens" }]],
      },
    ]);
    expect(renderRichTextHtml(blocks)).toBe("<ol><li>Erstens</li><li>Zweitens</li></ol>");
  });
});

describe("parseRichText — Zeilenumbruch innerhalb eines Absatzes", () => {
  it("\\n innerhalb eines Absatzes wird als <br> gerendert, Leerzeile trennt Absätze", () => {
    const blocks = parseRichText("Zeile eins\nZeile zwei\n\nNeuer Absatz");
    expect(blocks).toEqual([
      { type: "paragraph", runs: [{ text: "Zeile eins\nZeile zwei" }] },
      { type: "paragraph", runs: [{ text: "Neuer Absatz" }] },
    ]);
    const html = renderRichTextHtml(blocks);
    expect(html).toBe("<p>Zeile eins<br>Zeile zwei</p><p>Neuer Absatz</p>");
  });
});

describe("parseRichText — leere Eingabe", () => {
  it("leerer String ergibt leere Blockliste", () => {
    expect(parseRichText("")).toEqual([]);
    expect(parseRichText("   \n\n  ")).toEqual([]);
  });

  it("leere Blockliste rendert zu leerem HTML und Klartext", () => {
    expect(renderRichTextHtml([])).toBe("");
    expect(plainText([])).toBe("");
  });
});

describe("renderRichTextPdf", () => {
  it("erzeugt ein gültiges PDF (%PDF-Header) für einen 200-Zeilen-Text ohne Fehler", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `Zeile ${i + 1} mit **fett** und _kursiv_ und einem Link [x](https://example.com/${i}).`);
    const markdown = lines.join("\n\n") + "\n\n- Punkt eins\n- Punkt zwei\n\n1. Erstens\n2. Zweitens";
    const blocks = parseRichText(markdown);

    return new Promise<void>((resolve, reject) => {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("error", reject);
      doc.on("end", () => {
        const pdf = Buffer.concat(chunks);
        expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
        resolve();
      });

      expect(() => {
        renderRichTextPdf(doc, blocks, { x: 50, width: 495 });
      }).not.toThrow();

      doc.end();
    });
  });
});

describe("plainText — Round-Trip für reinen Text", () => {
  it("plainText(parseRichText(x)) === x für unformatierten Text ohne Sonderzeichen", () => {
    const inputs = ["Hallo Welt", "Erster Absatz\n\nZweiter Absatz", "Zeile eins\nZeile zwei"];
    for (const input of inputs) {
      expect(plainText(parseRichText(input))).toBe(input);
    }
  });

  it("Listen erhalten \"- \"/\"1. \"-Präfix im Klartext", () => {
    const blocks = parseRichText("- A\n- B");
    expect(plainText(blocks)).toBe("- A\n- B");

    const ordered = parseRichText("1. A\n2. B");
    expect(plainText(ordered)).toBe("1. A\n2. B");
  });
});
