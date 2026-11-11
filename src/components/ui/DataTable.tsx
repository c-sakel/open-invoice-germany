import Link from "next/link";
import type { ReactNode } from "react";
import { EmptyState } from "./EmptyState";

export interface DataColumn<T> {
  key: string;
  header: string;
  align?: "left" | "right";
  /** Rolle in der mobilen Kartenansicht: Titelzeile, Betrag rechts, Meta-Zeile oder ausgeblendet. */
  mobile: "title" | "amount" | "meta" | "hidden";
  cell: (row: T) => ReactNode;
}

interface DataTableProps<T> {
  rows: T[];
  columns: DataColumn<T>[];
  rowKey: (row: T) => string;
  rowHref?: (row: T) => string;
  empty: { text: string; action?: { label: string; href: string } };
  /** Zugaengliche Beschriftung der Tabelle (visuell verborgen). */
  caption: string;
}

function isRight<T>(col: DataColumn<T>): boolean {
  return col.align === "right" || col.mobile === "amount";
}

/** Tabelle ab `sm`, darunter Kartenliste aus denselben Spalten. Server-Komponente. */
export function DataTable<T>({ rows, columns, rowKey, rowHref, empty, caption }: DataTableProps<T>) {
  if (rows.length === 0) return <EmptyState text={empty.text} action={empty.action} />;

  const titles = columns.filter((c) => c.mobile === "title");
  const amounts = columns.filter((c) => c.mobile === "amount");
  const metas = columns.filter((c) => c.mobile === "meta");

  return (
    <>
      <table className="hidden w-full text-sm sm:table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-rule-strong text-left text-[13px] font-medium text-ink-muted">
            {columns.map((c) => (
              <th key={c.key} scope="col" className={`px-3 py-2 font-medium ${isRight(c) ? "text-right" : "text-left"}`}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className="border-b border-rule last:border-b-0 hover:bg-well">
              {columns.map((c, i) => {
                const content = c.cell(row);
                return (
                  <td key={c.key} className={isRight(c) ? "tabular whitespace-nowrap px-3 py-2.5 text-right" : "px-3 py-2.5"}>
                    {rowHref && i === 0 ? (
                      <Link href={rowHref(row)} className="font-medium text-ink hover:text-pen">
                        {content}
                      </Link>
                    ) : (
                      content
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="divide-y divide-rule sm:hidden" aria-label={caption}>
        {rows.map((row) => {
          const titleContent = titles.map((c) => <span key={c.key}>{c.cell(row)}</span>);
          return (
            <li key={rowKey(row)} className="py-3">
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0 font-medium text-ink">
                  {rowHref ? <Link href={rowHref(row)}>{titleContent}</Link> : titleContent}
                </div>
                {amounts.length > 0 && (
                  <div className="tabular whitespace-nowrap text-right font-medium text-ink">
                    {amounts.map((c) => (
                      <span key={c.key}>{c.cell(row)}</span>
                    ))}
                  </div>
                )}
              </div>
              {metas.length > 0 && (
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-muted">
                  {metas.map((c) => (
                    <span key={c.key}>{c.cell(row)}</span>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
