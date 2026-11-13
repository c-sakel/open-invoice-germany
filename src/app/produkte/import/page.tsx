import Link from "next/link";
import { PageContainer } from "@/components/PageContainer";
import { CsvImportForm } from "@/components/import/CsvImportForm";

export const dynamic = "force-dynamic";

export default function ProdukteImportPage() {
  return (
    <PageContainer width="form">
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Link href="/produkte" className="text-sm text-ink-muted hover:text-ink">
            ← Produkte
          </Link>
          <h1 className="text-2xl font-bold tracking-tight">Produkte importieren</h1>
        </div>
        <div className="space-y-2 text-sm text-ink-soft">
          <p>Pflichtspalten: Bezeichnung, Nettopreis (z. B. 95,00). Optional: Artikelnummer, Beschreibung, Einheit, Steuersatz, Steuerkategorie, Differenzbesteuerung.</p>
          <p>Bestehende Datensätze werden nicht geändert; die Datei wird erst nach der Vorschau und ohne Fehler importiert (alle Zeilen oder keine). Die Datei selbst wird nicht gespeichert. Höchstens 2 MB und 2.000 Zeilen, UTF-8 oder Windows-1252, Trennzeichen Semikolon oder Komma.</p>
          <p>
            <a href="/api/imports/products" download className="underline underline-offset-2">
              Vorlage herunterladen
            </a>
          </p>
        </div>
        <CsvImportForm resource="products" noun="Produkte" listHref="/produkte" />
      </div>
    </PageContainer>
  );
}
