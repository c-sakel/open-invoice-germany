/**
 * Beschreibungsdatei `index.xml` nach dem GDPdU-Beschreibungsstandard (Datentraegerueberlassung,
 * Z3-Zugriff nach § 147 Abs. 6 AO, Phase 16a). Die DTD liegt als `gdpdu-01-09-2004.dtd` im
 * Verzeichnis; der Inhalt steht zusaetzlich als Konstante hier, weil Dateien neben dem Quelltext
 * im Next-Build nicht zuverlaessig mitgeliefert werden (Test haelt beide gleich).
 *
 * Hinweis: Die DTD ist eine Nachbildung der oeffentlich beschriebenen Struktur; vor einer
 * Pruefung mit der amtlichen Datei der Finanzverwaltung abgleichen.
 */
import type { CsvColumn } from "@/domain/audit/export-csv";

export const GDPDU_DTD_FILENAME = "gdpdu-01-09-2004.dtd";

export const GDPDU_DTD = `<?xml version="1.0" encoding="UTF-8"?>
<!-- GDPdU-Beschreibungsstandard, Version 01.09.2004 -->
<!ELEMENT DataSet (Version, DataSupplier?, Command?, Media+)>
<!ELEMENT Version (#PCDATA)>
<!ELEMENT DataSupplier (Name, Location, Comment)>
<!ELEMENT Command (Comment)>
<!ELEMENT Media (Name, Table+)>
<!ELEMENT Table (URL, Name, Description?, Validity?, DecimalSymbol?, DigitGroupingSymbol?, Range?, (VariableLength | FixedLength))>
<!ELEMENT URL (#PCDATA)>
<!ELEMENT Name (#PCDATA)>
<!ELEMENT Description (#PCDATA)>
<!ELEMENT Location (#PCDATA)>
<!ELEMENT Comment (#PCDATA)>
<!ELEMENT Validity (Range+)>
<!ELEMENT Range (From, (To | Length)?)>
<!ELEMENT From (#PCDATA)>
<!ELEMENT To (#PCDATA)>
<!ELEMENT Length (#PCDATA)>
<!ELEMENT DecimalSymbol (#PCDATA)>
<!ELEMENT DigitGroupingSymbol (#PCDATA)>
<!ELEMENT VariableLength (ColumnDelimiter, RecordDelimiter, TextEncapsulator?, VariablePrimaryKey*, VariableColumn+, ForeignKey*)>
<!ELEMENT FixedLength (RecordDelimiter?, FixedPrimaryKey*, FixedColumn+, ForeignKey*)>
<!ELEMENT ColumnDelimiter (#PCDATA)>
<!ELEMENT RecordDelimiter (#PCDATA)>
<!ELEMENT TextEncapsulator (#PCDATA)>
<!ELEMENT VariablePrimaryKey (Name)>
<!ELEMENT FixedPrimaryKey (Name)>
<!ELEMENT ForeignKey (Name+, References)>
<!ELEMENT References (Name+)>
<!ELEMENT VariableColumn (Name, Description?, (Numeric | AlphaNumeric | Date), MaxLength?)>
<!ELEMENT FixedColumn (Name, Description?, (Numeric | AlphaNumeric | Date), FixedRange)>
<!ELEMENT FixedRange (From, (To | Length))>
<!ELEMENT MaxLength (#PCDATA)>
<!ELEMENT Numeric (Accuracy?)>
<!ELEMENT AlphaNumeric EMPTY>
<!ELEMENT Date (Format?)>
<!ELEMENT Accuracy (#PCDATA)>
<!ELEMENT Format (#PCDATA)>
`;

export interface IndexTable {
  file: string;
  name: string;
  description: string;
  columns: readonly CsvColumn[];
}

export interface IndexXmlInput {
  supplierName: string;
  supplierLocation: string;
  comment: string;
  tables: readonly IndexTable[];
}

export function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function columnType(c: CsvColumn): string {
  switch (c.type) {
    case "int":
      return "<Numeric/>";
    case "amount":
      return "<Numeric><Accuracy>2</Accuracy></Numeric>";
    case "quantity":
      return "<Numeric><Accuracy>3</Accuracy></Numeric>";
    case "date":
      return "<Date><Format>DD.MM.YYYY</Format></Date>";
    default:
      return "<AlphaNumeric/>";
  }
}

export function buildIndexXml(input: IndexXmlInput): string {
  const tables = input.tables
    .map(
      (t) => `    <Table>
      <URL>${xmlEscape(t.file)}</URL>
      <Name>${xmlEscape(t.name)}</Name>
      <Description>${xmlEscape(t.description)}</Description>
      <DecimalSymbol>,</DecimalSymbol>
      <DigitGroupingSymbol></DigitGroupingSymbol>
      <Range><From>2</From></Range>
      <VariableLength>
        <ColumnDelimiter>;</ColumnDelimiter>
        <RecordDelimiter>&#13;&#10;</RecordDelimiter>
        <TextEncapsulator>&quot;</TextEncapsulator>
${t.columns.map((c) => `        <VariableColumn><Name>${xmlEscape(c.name)}</Name>${columnType(c)}</VariableColumn>`).join("\n")}
      </VariableLength>
    </Table>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE DataSet SYSTEM "${GDPDU_DTD_FILENAME}">
<DataSet>
  <Version>1.0</Version>
  <DataSupplier>
    <Name>${xmlEscape(input.supplierName)}</Name>
    <Location>${xmlEscape(input.supplierLocation)}</Location>
    <Comment>${xmlEscape(input.comment)}</Comment>
  </DataSupplier>
  <Media>
    <Name>Datentraeger 1</Name>
${tables}
  </Media>
</DataSet>
`;
}
