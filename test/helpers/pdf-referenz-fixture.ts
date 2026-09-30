/**
 * Fixture "Referenzbeleg" fuer die PDF-Umbruch-Tests (fix/pdf-umbrueche): neun Positionen
 * mit langen Aufzaehlungs-Beschreibungen, die auf Seite 1 bis in die Fusszeile reichten.
 * Texte stammen aus dem Referenzfall, Firmen-/Kundendaten sind fiktiv.
 */
import type { EInvoiceData, EInvoiceLine } from "@/lib/einvoice/types";
import type { PdfTheme } from "@/lib/pdf/theme";
import { testPdfTheme } from "./pdf-theme";

function item(n: number, description: string, quantityMilli: number, bullets: string[]): EInvoiceLine {
  const unitNetPriceCents = 6500;
  return {
    id: String(n),
    description,
    descriptionLong: bullets.join("\n"),
    quantityMilli,
    unit: "HUR",
    unitNetPriceCents,
    lineNetCents: Math.round((quantityMilli * unitNetPriceCents) / 1000),
    taxRate: 19,
    taxCategory: "S",
    lineType: "ITEM",
  };
}

export function referenzLines(): EInvoiceLine[] {
  return [
    item(1, "Übernahme und Bestandsaufnahme E-Mail-Sicherheit und Archivierung (Sicherheitsdienst)", 3000, [
      "- Übernahme des Kunden in das Partnerkonto beim Sicherheitsdienst (365 Total Protection Enterprise Backup, Plan 3); Einrichtung eines  API-Zugangs für wiederholbare, automatisierte Prüfungen",
      "- Vollständige Ist-Erhebung aller Module (Spam- und Malwareschutz, ATP, Archivierung, Verschlüsselung, Continuity, Backup) über die Hersteller-API",
      "- Auswertung des Mailflusses 2020–2026: Nachweis, dass seit 14.01.2026 keine E-Mail mehr über den Schutzdienst lief und ausgehende Geschäftspost nie archiviert wurde — bezahlte Leistungen ohne Wirkung",
      "- Abgleich mit DNS, Microsoft-365-Konfiguration und Anwendungsberechtigungen",
      "- Befundbericht mit sechs Befunden und Handlungsempfehlungen",
      "- Umstellung der Sicherheitsalarme vom Vordienstleister",
    ]),
    item(2, "Prüfung und Härtung der Datensicherung Microsoft 365", 2500, [
      "- Orientiert an BSI IT-Grundschutz CON.3 „Datensicherungskonzept“; VDA ISA (TISAX) Themenfeld Datensicherung",
      "",
      "- Prüfung der Sicherungsabdeckung aller Postfächer, OneDrive-Konten, Teams-Chats und 53 SharePoint-Sites; Fehleranalyse veralteter Sicherungen",
      "- Aufnahme von Entra ID (Benutzer und Gruppen, 104 Objekte) in die Sicherung; automatische Aufnahme neu angelegter Konten, Gruppen und Sites",
      "- Einrichtung der Überwachung: Warnungen bei Backup-Problemen und fehlgeschlagenen Wiederherstellungen, tägliche Statusübersicht; Entfernung des Vordienstleisters aus den Empfängern",
      "- Erster dokumentierter Wiederherstellungstest — nicht überschreibend, in separaten Zielordner, Ergebnis per Schnittstelle verifiziert",
      "- Neu-Autorisierung der Microsoft-365-Anbindung (Regrant) auf aktuellem Stand",
      "- Herstellerticket zum Entzug des Administratorzugangs des Vordienstleisters inkl. Auskunft über dessen letzte Aktivität",
    ]),
    item(3, "Revisionssichere Aufbewahrung nach GoBD", 1000, [
      "• GoBD, § 147 AO (Aufbewahrungsfristen); BSI IT-Grundschutz OPS.1.2.2 „Archivierung“",
      "• Konzeption der Aufbewahrung für E-Mail, Dateien und Teams",
      "• Einrichtung zweier Microsoft-Purview-Aufbewahrungsrichtlinien: 10 Jahre ab Erstellung, keine automatische Löschung, änderbar ohne Unwiderruflichkeitssperre",
      "• Schließung der Aufbewahrungslücke seit Januar 2026 für den gesamten Tenant",
    ]),
    item(4, "Umstellung des Mailflusses über den Sicherheitsdienst", 4500, [
      "- BSI IT-Grundschutz APP.5.3 „Allgemeiner E-Mail-Client und -Server“; DSGVO Art. 32 (technische Maßnahmen)",
      "- Korrektur des Zustellziels beim Sicherheitsdienst",
      "- Einrichtung eingehender Connector (IP-gebunden, TLS erzwungen) mit Enhanced Filtering, damit Microsoft die echte Absenderadresse bewertet",
      "- Einrichtung ausgehender Connector mit Smarthost und TLS-Zertifikatsprüfung",
      "- Erweiterung SPF, Einrichtung DKIM-Signatur über den Sicherheitsdienst",
      "- Transportregel gegen Umgehung des Sicherheitsdienstes (Testbetrieb)",
      "- Funktionstests ein- und ausgehend inkl. Header-Analyse",
      "- Ergebnis: Filter, ATP und Archiv wirken wieder für ein- und ausgehende E-Mail",
    ]),
    item(5, "Härtung der E-Mail-Sicherheit", 1500, [
      "- Aktivierung URL-Rewriting (Link-Prüfung beim Klick) und Targeted Fraud Forensics (Schutz vor CEO-Fraud)",
      "- Absenderprüfung SPF für eigene Domänen, DMARC nach Richtlinie des Absenders",
      "- Anhangsfilter: Makro-Office-Dateien eingehend entfernt, ausgehend zugelassen; gezielte Ausnahme für die Konzerngesellschaft; ausführbare Dateien gesperrt",
      "- Recherche Herstellerempfehlungen und Best Practices, Abgleich mit dem Ist",
    ]),
    item(6, "Ablösung Sophos durch Microsoft Defender for Business", 3500, [
      "- BSI IT-Grundschutz OPS.1.1.4 „Schutz vor Schadprogrammen“; VDA ISA (TISAX) Themenfeld Schutz vor Schadsoftware",
      "- Prüfung Sophos Central: kein aktiv genutztes Gerät mehr geschützt",
      "- Analyse der Endgeräte (Einbindung, Verwaltung, Aktivität)",
      "- Einrichtung Microsoft Defender for Business (in vorhandener Lizenz enthalten): automatisches Onboarding aller verwalteten Windows-Geräte, EDR im Blockiermodus, Manipulationsschutz, Webfilter, Alarmierung",
      "- Intune-Richtlinien für alle Geräte: Virenschutz (Echtzeit, Cloud-Schutz hoch, PUA, Netzwerkschutz), Firewall, 19 Regeln zur Angriffsflächenreduzierung im Überwachungsmodus, Einbindung der Defender-Risikostufe in die Compliance",
      "- Einsparung der Sophos-Lizenzen (264 €/Jahr) vorbereitet",
    ]),
    item(7, "Lizenz- und Vertragsbereinigung", 1000, [
      "- Umstellung des Administratorkontos auf passende Lizenz ohne Funktionsverlust; eine Business-Premium-Lizenz frei",
      "- Abbestellung eines ungenutzten Zusatzabonnements (VM-Backup)",
      "- Preis- und Tarifrecherche beim Sicherheitsdienst, Auswertung der Abrechnungsregeln",
    ]),
    item(8, "IT-Notfallhandbuch nach BSI-Standard 200-4", 4000, [
      "- BSI-Standard 200-4 (Business Continuity Management), Stufe Reaktiv-BCMS; BSI IT-Grundschutz DER.4 „Notfallmanagement“; VDA ISA (TISAX) 1.6.1, 1.6.3, 5.2.8",
      "- Architektur und Einzelausfallpunkte um Mailweg und Endgeräteschutz ergänzt",
      "- Neuer Wiederherstellungsweg mit Eskalationsstufen und der Grundregel „nichts überschreiben“",
      "- Zwei neue Notfallszenarien: Ausfall des Mailwegs (mit Notbetrieb und Rückfall) und Schadsoftwarefund; Ergänzung Szenario Kompromittierung um Geräteisolation",
      "- Aktualisierung Notfallkontakte, Wiederanlaufreihenfolge, Zugangs- und Verwahrortverzeichnis, Übergabekapitel",
      "- Befundverzeichnis: drei Befunde erledigt, zwei neu bewertet, zwei neu aufgenommen; Maßnahmenplan aktualisiert; PDF-Fassung erstellt",
    ]),
    item(9, "Laufende Dokumentation und Übergabefähigkeit", 1000, [
      "- Arbeitsstand, Umstellungsplan, Änderungsprotokolle je Eingriff",
      "- Fortschreibung der Betriebsdokumentation für die Übergabefähigkeit an Dritte",
    ]),
  ];
}

export function referenzInvoice(): EInvoiceData {
  const lines = referenzLines();
  const net = lines.reduce((s, l) => s + l.lineNetCents, 0);
  const tax = Math.round(net * 0.19);
  return {
    number: "RE-2073-00042",
    type: "INVOICE",
    issueDate: new Date("2073-09-30"),
    currency: "EUR",
    seller: {
      name: "Einzelunternehmen Max Mustermann",
      addressLine1: "Musterweg 10",
      postalCode: "12345",
      city: "Musterstadt",
      countryCode: "DE",
      vatId: "DE123456789",
      taxNumber: "12/345/67890",
      email: "kontakt@beispiel-hosting.example",
      phone: "01234 567890",
    },
    buyer: { name: "Beispiel Automotive GmbH", addressLine1: "Kundenstraße 13", postalCode: "54321", city: "Kundenstadt", countryCode: "DE", customerNumber: "KD-00002" },
    lines,
    taxSubtotals: [{ taxRate: 19, taxCategory: "S", netCents: net, taxCents: tax }],
    netTotalCents: net,
    taxTotalCents: tax,
    grossTotalCents: net + tax,
    payableCents: net + tax,
    giroAmountCents: net + tax,
    iban: "DE02120300000000202051",
    bic: "BYLADEM1001",
    bankName: "Beispielbank Musterstadt",
    headerText: "Wir erlauben uns, folgende Leistungen in Rechnung zu stellen:",
    footerText: "Vielen Dank für Ihren Auftrag.",
  };
}

export function referenzTheme(overrides: Partial<PdfTheme> = {}): PdfTheme {
  return testPdfTheme({ layoutId: "schlicht", footerFacts: { website: "Beispiel-Hosting.example", ownerName: "Max Mustermann" }, ...overrides });
}
