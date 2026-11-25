import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

vi.mock("next/link", () => ({
  default: (props: { href: string; children?: ReactNode }) => <a href={props.href}>{props.children}</a>,
}));
vi.mock("@/app/actions/masterdata", () => ({ archiveCustomer: async () => undefined }));

const Loading = (await import("@/app/loading")).default;
const KundenLoading = (await import("@/app/kunden/loading")).default;
const EditorLoading = (await import("@/app/rechnungen/neu/loading")).default;
const ErrorPage = (await import("@/app/error")).default;
const GlobalError = (await import("@/app/global-error")).default;
const NotFound = (await import("@/app/not-found")).default;
const { ArchiveCustomerButton } = await import("@/app/kunden/ArchiveCustomerButton");

describe("Lade- und Fehlerzustände", () => {
  it("loading-Segmente sind aria-busy und für Screenreader beschriftet", () => {
    for (const C of [Loading, KundenLoading, EditorLoading]) {
      const html = renderToStaticMarkup(<C />);
      expect(html).toContain('aria-busy="true"');
      expect(html).toContain("Lädt…");
    }
  });

  it("error.tsx zeigt feste Meldung, Erneut-versuchen, Übersicht und nur den digest", () => {
    const err = Object.assign(new Error("geheime Details SELECT * FROM x"), { digest: "abc123" });
    for (const C of [ErrorPage, GlobalError]) {
      const html = renderToStaticMarkup(<C error={err} reset={() => undefined} />);
      expect(html).toContain("Die Seite konnte nicht geladen werden.");
      expect(html).toContain("Erneut versuchen");
      expect(html).toContain("abc123");
      expect(html).not.toContain("geheime Details");
      expect(html).not.toContain("SELECT");
    }
    expect(renderToStaticMarkup(<ErrorPage error={err} reset={() => undefined} />)).toContain('href="/"');
  });

  it("not-found verweist zur Übersicht", () => {
    const html = renderToStaticMarkup(<NotFound />);
    expect(html).toContain("Seite nicht gefunden");
    expect(html).toContain('href="/"');
  });

  it("Archivieren je Kunde läuft über einen Bestätigungsdialog", () => {
    const html = renderToStaticMarkup(<ArchiveCustomerButton id="c1" name="Becker GmbH" />);
    expect(html).toContain("<dialog");
    expect(html).toContain("Becker GmbH");
    expect(html).toContain('value="c1"');
    expect(html).toContain("Archivieren");
  });
});
