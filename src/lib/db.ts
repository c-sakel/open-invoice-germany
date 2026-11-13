/**
 * Prisma-Client mit GoBD-Unveränderbarkeits-Guard.
 *
 * `prisma`      — allgemeiner Client (API-Routes, UI). Blockt update/delete an
 *                 festgeschriebenen Rechnungen/Positionen (status !== DRAFT).
 * `dbInternal`  — ungeschützter Client. NUR in geprüften Domain-Services
 *                 (finalize, cancel, recordPayment) verwenden, die kontrollierte
 *                 Statuswechsel vornehmen.
 */
import path from "node:path";
import { PrismaClient } from "@/generated/prisma/client";

/**
 * Löst einen relativen SQLite-`file:`-Pfad in einen ABSOLUTEN Pfad auf.
 * Notwendig, weil der von Bundlern (Next/Turbopack) gebündelte Client das
 * relative `./dev.db` sonst relativ zum Bundle statt zum Schema-Verzeichnis
 * auflöst. Die Prisma-CLI ankert relative Pfade am Schema-Verzeichnis (prisma/)
 * — das spiegeln wir hier. PostgreSQL-/absolute URLs bleiben unverändert.
 */
function resolveDatasourceUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url || !url.startsWith("file:")) return url;
  const filePath = url.slice("file:".length);
  if (path.isAbsolute(filePath)) return url;
  const abs = path.resolve(process.cwd(), "prisma", filePath.replace(/^\.\//, ""));
  return `file:${abs}`;
}

/**
 * Case-insensitiver "contains"-Filter, portabel ueber SQLite und Postgres (Phase
 * 8b, Ruling Task-1-Facts). SQLite `contains` ist fuer ASCII bereits case-
 * insensitiv (Datenbank-Collation), `mode: "insensitive"` ist dort ein
 * Laufzeitfehler (Prisma unterstuetzt den Modus nur bei Postgres) — deshalb wird
 * `mode` NUR gesetzt, wenn der Provider Postgres ist (erkannt am Praefix von
 * `DATABASE_URL`, analog `resolveDatasourceUrl` oben).
 */
export function ciContains(value: string): { contains: string; mode?: "insensitive" } {
  const url = process.env.DATABASE_URL ?? "";
  const isPostgres = url.startsWith("postgres");
  return isPostgres ? { contains: value, mode: "insensitive" } : { contains: value };
}

export class GobdImmutabilityError extends Error {
  constructor(public readonly ref: string) {
    super(
      `GoBD: Festgeschriebene Rechnung "${ref}" ist unveränderbar. ` +
        `Korrektur nur per Storno oder Korrekturrechnung (§ 146 Abs. 4 AO).`,
    );
    this.name = "GobdImmutabilityError";
  }
}

const globalForPrisma = globalThis as unknown as { __oigBase?: PrismaClient };
const datasourceUrl = resolveDatasourceUrl();
const base = globalForPrisma.__oigBase ?? new PrismaClient(datasourceUrl ? { datasourceUrl } : undefined);
if (process.env.NODE_ENV !== "production") globalForPrisma.__oigBase = base;

/** Ungeschützter Basis-Client — nur intern. */
export const dbInternal = base;

async function guardInvoiceWhere(where: unknown): Promise<void> {
  const rows = await base.invoice.findMany({
    where: (where ?? {}) as never,
    select: { id: true, number: true, status: true },
  });
  const locked = rows.find((r) => r.status !== "DRAFT");
  if (locked) throw new GobdImmutabilityError(locked.number ?? locked.id);
}

/**
 * B9 (Fix-Welle): `FinalInvoiceDeduction` ist der Abzugs-Snapshot einer Schlussrechnung
 * (Abschn. 14.8 UStAE) — genauso unveraenderlich wie die Rechnung/Zeilen selbst, aber
 * bisher ohne Guard (anders als `invoice`/`invoiceLine`). Anders als dort gibt es keinen
 * DRAFT-Status, ueber den eine Aenderung je legitim waere: die Zeilen werden
 * ausschliesslich einmalig innerhalb von `finalizeWithinTx` per `createMany` auf dem
 * ungeschuetzten `dbInternal`/Transaktions-Client geschrieben — ueber den geschuetzten
 * `prisma`-Client sind update/delete/updateMany/deleteMany deshalb IMMER verboten.
 */
class FinalInvoiceDeductionImmutabilityError extends Error {
  constructor() {
    super(
      "GoBD: FinalInvoiceDeduction ist ein unveraenderlicher Abzugs-Snapshot der Schlussrechnung " +
        "und kann nicht nachtraeglich geaendert oder geloescht werden (Abschn. 14.8 UStAE).",
    );
    this.name = "FinalInvoiceDeductionImmutabilityError";
  }
}

async function guardLineWhere(where: unknown): Promise<void> {
  const rows = await base.invoiceLine.findMany({
    where: (where ?? {}) as never,
    select: { id: true, invoice: { select: { id: true, number: true, status: true } } },
  });
  const locked = rows.find((r) => r.invoice.status !== "DRAFT");
  if (locked) throw new GobdImmutabilityError(locked.invoice.number ?? locked.invoice.id);
}

/**
 * Phase 6: `Dunning` ist ein Geschaeftsbrief (GoBD) — nach Erstellung unveraenderlich,
 * analog `FinalInvoiceDeduction`. Eine Ausnahme bleibt ueber den geschuetzten Client
 * erlaubt: `sentAt` (tatsaechlicher Versandzeitpunkt, erst nach dem Mailversand bekannt).
 * `pdfPath`/`pdfSha256` (Mahnungsarchiv, Phase 16a) sind write-once und werden
 * ausschliesslich in `src/domain/dunning/archive.ts` per `dbInternal.dunning.updateMany`
 * mit `where: { pdfPath: null }` gesetzt — ueber den geschuetzten Client verboten. Jeder andere Schluessel
 * in `data` wird verweigert; delete/deleteMany sind — wie bei FinalInvoiceDeduction —
 * IMMER verboten.
 */
const DUNNING_MUTABLE_KEYS = new Set(["sentAt"]);

export class DunningImmutabilityError extends Error {
  constructor(badKeys: string[]) {
    super(
      `GoBD: Mahnung ist nach Erstellung unveraenderlich (Geschaeftsbrief). Nur sentAt ` +
        `duerfen nachtraeglich gesetzt werden, nicht: ${badKeys.join(", ")}.`,
    );
    this.name = "DunningImmutabilityError";
  }
}

function assertDunningUpdateAllowed(data: unknown): void {
  const keys = Object.keys((data ?? {}) as Record<string, unknown>);
  const badKeys = keys.filter((k) => !DUNNING_MUTABLE_KEYS.has(k));
  if (badKeys.length > 0) throw new DunningImmutabilityError(badKeys);
}

/**
 * Phase 16g: `LayoutDesignVersion` ist unveraenderlich (eingefrorene Belege verweisen darauf);
 * jede Aenderung der Konfiguration ist eine neue Zeile. `LayoutDesign` wird nie geloescht,
 * nur archiviert (`update` bleibt erlaubt: Name, archived, currentVersion).
 */
export class LayoutDesignVersionImmutabilityError extends Error {
  constructor() {
    super("GoBD: Layout-Design-Versionen sind unveraenderlich; Aenderungen erzeugen eine neue Version.");
    this.name = "LayoutDesignVersionImmutabilityError";
  }
}

/**
 * Phase 17a: Das VIES-Pruefprotokoll (`VatIdCheck`) ist append-only; nur `create` ist erlaubt.
 */
export class VatIdCheckImmutableError extends Error {
  constructor() {
    super("Pruefprotokoll ist unveraenderlich.");
    this.name = "VatIdCheckImmutableError";
  }
}

/**
 * Phase 16g (R7): `printOptionsJson` von Angebot/AB/Proforma (`quote`) und Lieferschein ist ab
 * dem Verlassen des Entwurfs eingefroren (Druckoptionen + Layout-Version). Der Guard prueft nur
 * den Schluessel `printOptionsJson`; alle anderen Felder (z. B. archivedAt) bleiben unberuehrt.
 * Die Statuspruefung ist ein separates findFirst (nicht atomar); die Domain-Pfade (setPrintOptions)
 * schreiben deshalb per bedingtem updateMany (status DRAFT) und sind selbst atomar.
 * Das Einfrieren selbst laeuft ueber den Transaktions-Client von `dbInternal` (freeze-layout.ts).
 */
export class FrozenPrintOptionsError extends Error {
  constructor(ref: string) {
    super(`GoBD: Die Druckoptionen von "${ref}" sind nach dem Verlassen des Entwurfs eingefroren.`);
    this.name = "FrozenPrintOptionsError";
  }
}

function touchesPrintOptions(data: unknown): boolean {
  return typeof data === "object" && data !== null && "printOptionsJson" in data;
}

async function guardPrintOptions(model: "quote" | "deliveryNote", where: unknown, data: unknown): Promise<void> {
  if (!touchesPrintOptions(data)) return;
  const filter = { AND: [(where ?? {}) as never, { status: { not: "DRAFT" } }] } as never;
  const row =
    model === "quote"
      ? await base.quote.findFirst({ where: filter, select: { id: true, number: true } })
      : await base.deliveryNote.findFirst({ where: filter, select: { id: true, number: true } });
  if (row) throw new FrozenPrintOptionsError(row.number ?? row.id);
}

export class LayoutDesignDeleteError extends Error {
  constructor() {
    super("Layout-Designs werden nie geloescht (eingefrorene Belege verweisen auf Versionen), nur archiviert.");
    this.name = "LayoutDesignDeleteError";
  }
}

/**
 * Phase 16a: `ArchivedDocument` ist write-once (GoBD-Belegarchiv). Zeilen entstehen
 * ausschliesslich in `src/domain/invoice/archive.ts` per `create` auf dem Transaktions-
 * Client; ueber den geschuetzten `prisma`-Client sind update/upsert/delete IMMER verboten.
 */
class ArchivedDocumentImmutabilityError extends Error {
  constructor() {
    super("GoBD: Archivierte Belege (ArchivedDocument) sind write-once und koennen nicht geaendert oder geloescht werden.");
    this.name = "ArchivedDocumentImmutabilityError";
  }
}

class PaymentImmutabilityError extends Error {
  constructor() {
    super("GoBD: Zahlungen werden nie geaendert oder geloescht — Korrektur nur per Gegenbuchung (reversePayment).");
    this.name = "PaymentImmutabilityError";
  }
}

export const prisma = base.$extends({
  query: {
    invoice: {
      async update({ args, query }) {
        await guardInvoiceWhere(args.where);
        return query(args);
      },
      async delete({ args, query }) {
        await guardInvoiceWhere(args.where);
        return query(args);
      },
      async updateMany({ args, query }) {
        await guardInvoiceWhere(args.where);
        return query(args);
      },
      async deleteMany({ args, query }) {
        await guardInvoiceWhere(args.where);
        return query(args);
      },
      async upsert({ args, query }) {
        await guardInvoiceWhere(args.where);
        return query(args);
      },
    },
    invoiceLine: {
      async update({ args, query }) {
        await guardLineWhere(args.where);
        return query(args);
      },
      async delete({ args, query }) {
        await guardLineWhere(args.where);
        return query(args);
      },
      async updateMany({ args, query }) {
        await guardLineWhere(args.where);
        return query(args);
      },
      async deleteMany({ args, query }) {
        await guardLineWhere(args.where);
        return query(args);
      },
    },
    finalInvoiceDeduction: {
      async update() {
        throw new FinalInvoiceDeductionImmutabilityError();
      },
      async delete() {
        throw new FinalInvoiceDeductionImmutabilityError();
      },
      async updateMany() {
        throw new FinalInvoiceDeductionImmutabilityError();
      },
      async deleteMany() {
        throw new FinalInvoiceDeductionImmutabilityError();
      },
    },
    archivedDocument: {
      async update() {
        throw new ArchivedDocumentImmutabilityError();
      },
      async updateMany() {
        throw new ArchivedDocumentImmutabilityError();
      },
      async updateManyAndReturn() {
        throw new ArchivedDocumentImmutabilityError();
      },
      async upsert() {
        throw new ArchivedDocumentImmutabilityError();
      },
      async delete() {
        throw new ArchivedDocumentImmutabilityError();
      },
      async deleteMany() {
        throw new ArchivedDocumentImmutabilityError();
      },
    },
    vatIdCheck: {
      async update() {
        throw new VatIdCheckImmutableError();
      },
      async updateMany() {
        throw new VatIdCheckImmutableError();
      },
      async updateManyAndReturn() {
        throw new VatIdCheckImmutableError();
      },
      async upsert() {
        throw new VatIdCheckImmutableError();
      },
      async delete() {
        throw new VatIdCheckImmutableError();
      },
      async deleteMany() {
        throw new VatIdCheckImmutableError();
      },
    },
    layoutDesignVersion: {
      async update() {
        throw new LayoutDesignVersionImmutabilityError();
      },
      async updateMany() {
        throw new LayoutDesignVersionImmutabilityError();
      },
      async updateManyAndReturn() {
        throw new LayoutDesignVersionImmutabilityError();
      },
      async upsert() {
        throw new LayoutDesignVersionImmutabilityError();
      },
      async delete() {
        throw new LayoutDesignVersionImmutabilityError();
      },
      async deleteMany() {
        throw new LayoutDesignVersionImmutabilityError();
      },
    },
    quote: {
      async update({ args, query }) {
        await guardPrintOptions("quote", args.where, args.data);
        return query(args);
      },
      async updateMany({ args, query }) {
        await guardPrintOptions("quote", args.where, args.data);
        return query(args);
      },
      async updateManyAndReturn({ args, query }) {
        await guardPrintOptions("quote", args.where, args.data);
        return query(args);
      },
      async upsert({ args, query }) {
        await guardPrintOptions("quote", args.where, args.update);
        return query(args);
      },
    },
    deliveryNote: {
      async update({ args, query }) {
        await guardPrintOptions("deliveryNote", args.where, args.data);
        return query(args);
      },
      async updateMany({ args, query }) {
        await guardPrintOptions("deliveryNote", args.where, args.data);
        return query(args);
      },
      async updateManyAndReturn({ args, query }) {
        await guardPrintOptions("deliveryNote", args.where, args.data);
        return query(args);
      },
      async upsert({ args, query }) {
        await guardPrintOptions("deliveryNote", args.where, args.update);
        return query(args);
      },
    },
    layoutDesign: {
      async delete() {
        throw new LayoutDesignDeleteError();
      },
      async deleteMany() {
        throw new LayoutDesignDeleteError();
      },
    },
    payment: {
      async update() {
        throw new PaymentImmutabilityError();
      },
      async updateMany() {
        throw new PaymentImmutabilityError();
      },
      async updateManyAndReturn() {
        throw new PaymentImmutabilityError();
      },
      async upsert() {
        throw new PaymentImmutabilityError();
      },
      async delete() {
        throw new PaymentImmutabilityError();
      },
      async deleteMany() {
        throw new PaymentImmutabilityError();
      },
    },
    dunning: {
      async update({ args, query }) {
        assertDunningUpdateAllowed(args.data);
        return query(args);
      },
      async updateMany({ args, query }) {
        assertDunningUpdateAllowed(args.data);
        return query(args);
      },
      async updateManyAndReturn({ args, query }) {
        assertDunningUpdateAllowed(args.data);
        return query(args);
      },
      // upsert: Anlage frei, der Update-Zweig unterliegt denselben Regeln wie update.
      async upsert({ args, query }) {
        assertDunningUpdateAllowed(args.update);
        return query(args);
      },
      async delete() {
        throw new DunningImmutabilityError(["delete"]);
      },
      async deleteMany() {
        throw new DunningImmutabilityError(["deleteMany"]);
      },
    },
  },
});
