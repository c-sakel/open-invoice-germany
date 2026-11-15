/**
 * Fixtures fuer DATEV-Exporttests: Organisation mit Kunden, bestaetigter Kontenzuordnung und Belegen
 * (fiktive Daten, kein Netz). Belegdaten liegen im Jahr 2096 (das Format erlaubt nur Jahre 20xx).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dbInternal } from "@/lib/db";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { updateNumberRange } from "@/domain/numbering/ranges";
import { applyDatevTemplate } from "@/domain/export/datev/mapping";
import { confirmDatevMapping, saveDatevSettings } from "@/domain/export/datev/settings";
import type { CreateInvoiceInput } from "@/schemas";

export interface DatevTestOrg {
  orgId: string;
  customerId: string;
  prefix: string;
}

export const have = (cmd: string, arg: string): boolean => {
  try {
    execFileSync(cmd, [arg], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** `year`: Nummernpraefix-Kennung (`DV<year>-<org3>`); je Testdatei eigene Organisation und eigener Praefix. */
export async function mkDatevOrg(name: string, year: string, issue: Date): Promise<DatevTestOrg> {
  const org = await dbInternal.organization.create({
    data: { legalName: name, addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" },
    select: { id: true },
  });
  const customer = await dbInternal.customer.create({
    data: { orgId: org.id, name: "Kunde AG", customerNumber: "K-1", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
    select: { id: true },
  });
  await ensureOrgMasterdata(dbInternal, org.id);
  const tail = org.id.slice(-3).toUpperCase();
  const prefix = `DV${year}-${tail}`;
  for (const type of ["INVOICE", "CREDIT_NOTE"] as const) {
    await updateNumberRange(org.id, type, { pattern: "{PREFIX}{YYYY}-{SEQ}", prefix: type === "INVOICE" ? prefix : `DG${year}-${tail}`, seqPadding: 4, yearlyReset: true, nextValue: 1 }, "test", issue);
  }
  return { orgId: org.id, customerId: customer.id, prefix };
}

export async function mkCustomer(o: DatevTestOrg, name: string, customerNumber: string | null, extra: Partial<{ type: string; vatId: string; postalCode: string; countryCode: string }> = {}): Promise<string> {
  return (
    await dbInternal.customer.create({
      data: { orgId: o.orgId, name, customerNumber, addressLine1: "Weg 2", postalCode: extra.postalCode ?? "12345", city: "Teststadt", type: extra.type ?? "BUSINESS", vatId: extra.vatId ?? null, countryCode: extra.countryCode ?? "DE" },
      select: { id: true },
    })
  ).id;
}

/** Einstellungen, SKR03-Vorlage, Bestaetigung. Fiktive Berater-/Mandantennummern. */
export async function setupDatev(orgId: string, settings: Record<string, unknown> = {}): Promise<void> {
  await saveDatevSettings(orgId, { consultantNumber: 123456, clientNumber: 12345, exportPayments: true, ...settings }, "test");
  await applyDatevTemplate(orgId, "SKR03", "test");
  await confirmDatevMapping(orgId, "mit dem Steuerberater abgestimmt", "test");
}

export interface MkInvoiceOptions {
  customerId?: string;
  issue: Date;
  netCents?: number;
  taxRate?: number;
  taxCategory?: string;
  taxScheme?: string;
  currency?: string;
  skonto?: boolean;
  type?: string;
  /** Festschreibezeitpunkt (Standard: `issue`); spaeter = nachtraeglich festgeschriebener Beleg mit altem Datum. */
  finalizeAt?: Date;
  notes?: string;
}

/** Festgeschriebene Rechnung (eine Position), `issue` ist Belegdatum und Festschreibezeitpunkt. */
export async function mkDatevInvoice(o: DatevTestOrg, opts: MkInvoiceOptions): Promise<{ id: string; number: string; grossCents: number }> {
  const input = {
    customerId: opts.customerId ?? o.customerId, type: opts.type ?? "INVOICE", taxScheme: opts.taxScheme ?? "REGULAR", currency: opts.currency ?? "EUR",
    documentDiscountPermille: 0, documentDiscountCents: 0, documentChargePermille: 0, documentChargeCents: 0,
    ...(opts.skonto ? { skonto1Permille: 20, skonto1Days: 10 } : {}),
    issueDate: opts.issue, deliveryDate: opts.issue,
    ...(opts.notes ? { notes: opts.notes } : {}),
    lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: opts.netCents ?? 10000, taxRate: opts.taxRate ?? 19, taxCategory: opts.taxCategory ?? "S", discountPermille: 0, discountCents: 0 }],
  } as CreateInvoiceInput;
  const draft = await createDraftInvoice(o.orgId, input, { now: opts.issue });
  const fin = await finalizeInvoice(draft.id, { now: opts.finalizeAt ?? opts.issue });
  return { id: fin.id, number: fin.number ?? "", grossCents: fin.grossTotalCents };
}

export interface UnzippedEntries {
  names: string[];
  read: (name: string) => Buffer;
}

export function unzipBuffer(zip: Buffer): UnzippedEntries & { cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), `oig-datev-${randomUUID().slice(0, 6)}-`));
  const file = path.join(dir, "x.zip");
  writeFileSync(file, zip);
  execFileSync("unzip", ["-t", file]);
  const names = execFileSync("unzip", ["-Z1", file]).toString("utf8").split("\n").filter(Boolean);
  return {
    names,
    read: (n) => execFileSync("unzip", ["-p", file, n], { maxBuffer: 50_000_000 }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Zellen einer Zeile; Semikolons in Anfuehrungszeichen trennen nicht. */
function splitCells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '""';
        i++;
        continue;
      }
      quoted = !quoted;
      cur += c;
    } else if (c === ";" && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Datenzeilen einer EXTF-Datei (CP1252 -> latin1 gelesen): Kopf, Spaltennamen, Daten; Zellen am Semikolon. */
export function parseExtf(buf: Buffer): { header: string[]; rows: string[][]; raw: string } {
  const raw = buf.toString("latin1");
  const lines = raw.split("\r\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return { header: lines[0].split(";"), rows: lines.slice(2).map(splitCells), raw };
}
