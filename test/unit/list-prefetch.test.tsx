import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

vi.mock("next/link", () => ({
  default: (props: { href: string; prefetch?: boolean; children?: ReactNode; className?: string }) => (
    <a href={props.href} data-prefetch={String(props.prefetch)}>
      {props.children}
    </a>
  ),
}));

const { DataTable } = await import("@/components/ui/DataTable");

interface Row {
  id: string;
  name: string;
}

describe("Zeilenlinks ohne Vorabladen", () => {
  it("DataTable setzt prefetch=false an Tabellen- und Kartenlinks", () => {
    const html = renderToStaticMarkup(
      <DataTable<Row>
        rows={[
          { id: "a", name: "A" },
          { id: "b", name: "B" },
        ]}
        columns={[{ key: "name", header: "Name", mobile: "title", cell: (r) => r.name }]}
        rowKey={(r) => r.id}
        rowHref={(r) => `/x/${r.id}`}
        empty={{ text: "leer" }}
        caption="Test"
      />,
    );
    const links = html.match(/<a [^>]*>/g) ?? [];
    expect(links.length).toBe(4);
    for (const l of links) expect(l).toContain('data-prefetch="false"');
  });

  it("Zeilenlinks in cell-Bloecken der Listenseiten haben prefetch={false}", () => {
    const files = ["kunden", "produkte", "abos", "rechnungen", "dokumente", "lieferscheine", "eingang", "bankabgleich"];
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(path.join(process.cwd(), "src/app", f, "page.tsx"), "utf8");
      const re = /cell:[\s\S]*?<Link(?![^>]*prefetch=\{false\})/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        // Treffer gilt nur, wenn der Link vor dem naechsten cell:-Block liegt
        if (!/cell:/.test(m[0].slice(5))) offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });
});
