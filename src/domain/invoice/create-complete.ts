/**
 * Phase 18d — Rechnung in EINER Transaktion anlegen, festschreiben und optional eine Zahlung erfassen.
 *
 * GoBD: Die Transaktion schreibt exakt dieselben Saetze wie die drei Einzelaufrufe
 * (createDraftInvoiceWithinTx -> finalizeWithinTx -> recordPaymentWithinTx): je Schritt ChangeLog
 * (CREATE, FINALIZE, PAYMENT), ActivityLog und Webhook-Outbox. Alles oder nichts: scheitert ein
 * Schritt (Festschreibe-Pflichtangabe, Ueberzahlung, fremder Kunde, `beforeCommit`), rollt die
 * ganze Transaktion zurueck — es bleiben weder Entwurf noch verbrauchte Belegnummer (keine
 * Nummernluecke). Bei Kettenkonflikt mit parallelen Schreibern wird die Transaktion wiederholt. Die Hinweise (VIES/Adresse) laufen VOR der Transaktion, weil sie das Netz
 * nutzen. Kein Versand: weder Mail noch Postversand.
 *
 * VatIdCheck (VIES-Pruefung der Hinweise) ist append-only und bleibt bei einem Rollback bestehen: die Pruefung
 * ist ein tatsaechlich erfolgter Abruf und gehoert zum Nachweis, auch wenn die Rechnung nicht entsteht (gewollt).
 */
import type { Prisma, Invoice, InvoiceLine, Payment } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { lockOrganization } from "@/lib/db-lock";
import { withChangeLogRetry } from "@/lib/chain-retry";
import { createDraftInvoiceWithinTx } from "@/domain/invoice/create";
import { finalizeWithinTx } from "@/domain/invoice/finalize";
import { recordPaymentWithinTx, PaymentError, type PaymentCreatedBy } from "@/domain/invoice/payment";
import { collectFinalizeWarningsFor, insertMeansWarnings, paymentMeansWarnings, MEANS_WARNING_SELECT } from "@/domain/invoice/finalize-warnings";
import { payableBaseCents } from "@/domain/invoice/amounts";
import { onInvoiceFinalizedOss } from "@/domain/notifications/hooks";
import { recordPaymentSchema, type AtomicPaymentInput, type CreateInvoiceInput } from "@/schemas";

export interface InvoiceCompleteResult {
  invoice: Invoice & { lines: InvoiceLine[]; payments: Payment[] };
  paymentId: string | null;
  warnings: string[];
}

export interface InvoiceCompleteOptions {
  payment?: AtomicPaymentInput;
  actor: string;
  createdBy: PaymentCreatedBy;
  now?: Date;
  fetchImpl?: typeof fetch;
  /** Laeuft in der Transaktion nach allen Schreibvorgaengen (z. B. Idempotenz-Antwort speichern); Wurf = Rollback. */
  beforeCommit?: (tx: Prisma.TransactionClient, result: InvoiceCompleteResult) => Promise<void>;
}

export async function createInvoiceComplete(
  orgId: string,
  input: CreateInvoiceInput,
  opts: InvoiceCompleteOptions,
): Promise<InvoiceCompleteResult> {
  const { payment, actor, createdBy, now } = opts;

  const preWarnings = await collectFinalizeWarningsFor(orgId, { customerId: input.customerId, taxScheme: input.taxScheme }, { fetchImpl: opts.fetchImpl, now });

  // Parallele Anlagen derselben Org: Org-Sperre serialisiert die ChangeLog-Kette (Postgres); ein dennoch
  // auftretender Kettenkonflikt (P2002 orgId+prevHash) wiederholt die GANZE Transaktion (Rollback ist vollstaendig,
  // beforeCommit laeuft je Versuch neu, Nach-Commit-Hooks nur einmal nach Erfolg).
  const result = await withChangeLogRetry(() => dbInternal.$transaction(
    async (tx): Promise<InvoiceCompleteResult> => {
      await lockOrganization(tx, orgId);
      const draft = await createDraftInvoiceWithinTx(tx, orgId, input, { actor, now });
      // Karte/Lastschrift-Hinweise (18e) aus dem gespeicherten Entwurf, ueber dieselbe Entscheidungsstelle
      // wie beim Festschreiben (paymentMeansWarnings).
      const stored = await tx.invoice.findUniqueOrThrow({ where: { id: draft.id }, select: MEANS_WARNING_SELECT });
      const warnings = insertMeansWarnings(preWarnings, paymentMeansWarnings(stored)).map((w) => w.message);
      const fin = await finalizeWithinTx(tx, draft.id, { actor, now });

      let paymentId: string | null = null;
      if (payment) {
        const amountCents = payment.amountCents ?? payableBaseCents(fin) - fin.paidAmountCents;
        if (amountCents <= 0) throw new PaymentError("Rechnung hat keinen offenen Betrag.");
        const recorded = await recordPaymentWithinTx(
          tx,
          fin.id,
          recordPaymentSchema.parse({ ...payment, amountCents, isSkonto: false, applySkonto: false }),
          { actor, now, orgId, createdBy },
        );
        paymentId = recorded.recorded.id;
      }

      const invoice = await tx.invoice.findUniqueOrThrow({
        where: { id: fin.id },
        include: { lines: { orderBy: { position: "asc" } }, payments: { orderBy: { createdAt: "asc" } } },
      });
      const out: InvoiceCompleteResult = { invoice, paymentId, warnings };
      await opts.beforeCommit?.(tx, out);
      return out;
    },
    { timeout: 20_000, maxWait: 10_000 },
  ));

  // Nach dem Commit (der Hook darf das Ergebnis nie kippen): OSS-Schwelle pruefen.
  try {
    await onInvoiceFinalizedOss(orgId, result.invoice.id, now);
  } catch (e) {
    console.error("OSS-Pruefung nach atomarer Rechnung fehlgeschlagen", e instanceof Error ? e.name : "Fehler");
  }
  return result;
}
