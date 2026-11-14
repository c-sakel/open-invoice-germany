/**
 * Erzeugt gueltiges CAMT-XML fuer Tests (fiktive Daten, kein Netz).
 */
export interface CamtBuilderTx {
  amountCents: number;
  name?: string;
  iban?: string;
  remittance?: string;
  endToEndId?: string;
  returnReason?: string;
  /** Einzelbuchung ohne eigenen Betrag (Betrag steht nur am Eintrag). */
  noAmount?: boolean;
}

export interface CamtBuilderEntry {
  /** Buchungstag YYYY-MM-DD. */
  date: string;
  direction?: "CRDT" | "DBIT";
  status?: "BOOK" | "PDNG";
  /** Rueckbuchungskennzeichen RvslInd=true. */
  reversal?: boolean;
  /** Bankumsatzschluessel am Eintrag, z. B. ["PMNT", "IDDT", "RDDT"]. */
  bankTxCode?: [string, string, string];
  currency?: string;
  txs: CamtBuilderTx[];
}

export interface CamtBuilderOptions {
  format: "053" | "054";
  /** Schemaversion, z. B. 2 oder 8. */
  version: number;
  iban: string;
  entries: CamtBuilderEntry[];
  /** Namensraum-Praefix, z. B. "ns2". */
  prefix?: string;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function eur(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export function buildCamt(o: CamtBuilderOptions): string {
  const p = o.prefix ? `${o.prefix}:` : "";
  const t = (name: string, inner: string, attrs = ""): string => `<${p}${name}${attrs}>${inner}</${p}${name}>`;
  const ver = String(o.version).padStart(2, "0");
  const ns = `urn:iso:std:iso:20022:tech:xsd:camt.${o.format}.001.${ver}`;
  const nsAttr = o.prefix ? ` xmlns:${o.prefix}="${ns}"` : ` xmlns="${ns}"`;

  const entries = o.entries.map((e) => {
    const dir = e.direction ?? "CRDT";
    const status = e.status ?? "BOOK";
    const total = e.txs.reduce((s, x) => s + x.amountCents, 0);
    const details = e.txs.map((x) => {
      let inner = "";
      if (x.endToEndId) inner += t("Refs", t("EndToEndId", esc(x.endToEndId)));
      if (!x.noAmount) inner += t("Amt", eur(x.amountCents), ` Ccy="${e.currency ?? "EUR"}"`);
      const party =
        (x.name ? t("Dbtr", t("Nm", esc(x.name))) : "") +
        (x.iban ? t("DbtrAcct", t("Id", t("IBAN", esc(x.iban)))) : "");
      if (party) inner += t("RltdPties", party);
      if (x.returnReason) inner += t("RtrInf", t("Rsn", t("Cd", esc(x.returnReason))));
      if (x.remittance) inner += t("RmtInf", t("Ustrd", esc(x.remittance)));
      return t("TxDtls", inner);
    });
    const sts = o.version >= 8 ? t("Sts", t("Cd", status)) : t("Sts", status);
    return t(
      "Ntry",
      t("Amt", eur(total), ` Ccy="${e.currency ?? "EUR"}"`) +
        t("CdtDbtInd", dir) +
        (e.reversal ? t("RvslInd", "true") : "") +
        sts +
        t("BookgDt", t("Dt", e.date)) +
        (e.bankTxCode
          ? t("BkTxCd", t("Domn", t("Cd", e.bankTxCode[0]) + t("Fmly", t("Cd", e.bankTxCode[1]) + t("SubFmlyCd", e.bankTxCode[2]))))
          : "") +
        t("NtryDtls", details.join("")),
    );
  });

  const stmtName = o.format === "053" ? "Stmt" : "Ntfctn";
  const containerName = o.format === "053" ? "BkToCstmrStmt" : "BkToCstmrDbtCdtNtfctn";
  const stmt = t(stmtName, t("Id", "TEST-STMT") + t("Acct", t("Id", t("IBAN", esc(o.iban)))) + entries.join(""));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${p}Document${nsAttr}>${t(containerName, stmt)}</${p}Document>`;
}
