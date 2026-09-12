/**
 * Erzeugt aus Abos die fälligen Rechnungen.
 *
 * Pro Lauf entsteht je fälliger Periode ein regulärer Rechnungs-ENTWURF
 * (oder direkt festgeschrieben bei `autoFinalize`). Alles in EINER Transaktion
 * je Rechnung: Beleg + Audit-Eintrag + Fortschreiben des Abos sind atomar — ein
 * Fehler beim Festschreiben rollt die Erzeugung zurück (keine doppelte Vergabe,
 * kein „Loch").
 *
 * Datum: Rechnungsdatum = Erstellungstag (`now`), Leistungsdatum = Perioden-
 * Stichtag, fällig = `now` + Zahlungsziel. `nextRunDate` wird vom Stichtag aus
 * fortgeschrieben (nicht von `now`), damit der Rhythmus stabil bleibt.
 *
 * Phase 14a, Task 1 (§28-§30, R1-R5): die Rechnung entsteht über
 * `createDraftInvoiceWithinTx` — denselben Pfad wie jede manuell angelegte Rechnung.
 * Nummernvergabe, `assertAllowedTaxRates`, Netto-/Steuerberechnung, Snapshots und
 * Textvorlagen laufen dadurch identisch; Felder, die das Abo selbst nicht führt
 * (Zahlungsmethode, Ansprechpartner, Rechnungs-/Lieferadresse, Belegrabatt,
 * Bestellreferenz, Zahlungsbedingungstext, Kopf-/Fußtextvorlage), kommen jetzt aus den
 * Kundenvorgaben statt leer zu bleiben.
 */
import { dbInternal } from "@/lib/db";
import { onRecurringFailed } from "@/domain/notifications/hooks";
import { linkDocuments } from "@/domain/relations";
import { createDraftInvoiceWithinTx } from "@/domain/invoice/create";
import { finalizeWithinTx } from "@/domain/invoice/finalize";
import { ratesOfLines } from "@/domain/settings/tax-rates";
import { advanceDate, periodRange, type RecurInterval } from "@/lib/recurring";
import { formatDateDe } from "@/lib/template/format";
import { prefillEmail } from "@/domain/email/compose";
import { sendDocumentEmail } from "@/domain/email/send";
import type { MailProvider } from "@/lib/mail/provider";
import type { CreateInvoiceInput } from "@/schemas";
import { RecurringError } from "./create";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RunOptions {
  now?: Date;
  actor?: string;
  /** Provider-Injektion fuer Tests (Muster: `runDunningJob`) — Standard: echter SMTP-Versand. */
  provider?: MailProvider;
}

export interface EmittedInvoice {
  invoiceId: string;
  number: string | null;
  periodDate: Date;
  finalized: boolean;
  /** Ergebnis des automatischen Versands (autoSend, Phase 7, §33) — fehlt, wenn autoSend aus ist. */
  emailStatus?: "SENT" | "FAILED" | "SKIPPED";
  emailError?: string;
}

/**
 * Versendet die erzeugte Rechnung ueber die Standardvorlage INVOICE (autoSend, Phase 7,
 * §33) — LAEUFT AUSSERHALB jeder Prisma-Transaktion (Modulkommentar: kein SMTP-Aufruf
 * innerhalb einer Transaktion). Ohne Kunden-E-Mail oder Mailkonfiguration: SKIPPED statt
 * eines geworfenen Fehlers — der Lauf der uebrigen Abos darf nicht abbrechen.
 */
async function sendRecurringInvoiceEmail(
  orgId: string,
  invoiceId: string,
  provider: MailProvider | undefined,
  emailTemplateId: string | null,
): Promise<{ status: "SENT" | "FAILED" | "SKIPPED"; error?: string }> {
  try {
    // emailTemplateId (Phase 8b, §43): ohne Angabe greift weiterhin die Standardvorlage
    // INVOICE (prefillEmail waehlt sie selbst, wenn templateId undefined ist).
    const pre = await prefillEmail(orgId, { docType: "INVOICE", docId: invoiceId, templateId: emailTemplateId ?? undefined });
    if (pre.to.length === 0) return { status: "SKIPPED" };
    const result = await sendDocumentEmail(
      orgId,
      "recurring-runner",
      {
        docType: "INVOICE",
        docId: invoiceId,
        to: pre.to.join(","),
        cc: pre.cc.join(","),
        bcc: pre.bcc.join(","),
        subject: pre.subject,
        body: pre.body,
        signature: pre.signature,
        copyToSelf: pre.copyToSelf,
        standardAttachments: pre.defaultStandardAttachments,
        templateId: pre.templateId,
        warnings: pre.warnings,
      },
      [],
      provider,
    );
    return result.status === "SENT" ? { status: "SENT" } : { status: "FAILED", error: result.error };
  } catch (e) {
    return { status: "FAILED", error: e instanceof Error ? e.message : String(e) };
  }
}

/** Erzeugt genau EINE Rechnung für die aktuelle Periode und schiebt das Abo weiter. */
async function emitOne(
  recurringId: string,
  now: Date,
  actor: string,
  provider?: MailProvider,
): Promise<{ result: EmittedInvoice; ended: boolean; autoSend: boolean; orgId: string; emailTemplateId: string | null }> {
  const created = await dbInternal.$transaction(async (tx) => {
    const rec = await tx.recurringInvoice.findUnique({
      where: { id: recurringId },
      include: { lines: { orderBy: { position: "asc" } } },
    });
    if (!rec) throw new RecurringError("Abo nicht gefunden.");
    if (rec.status !== "ACTIVE") throw new RecurringError("Abo ist nicht aktiv.");
    if (rec.lines.length === 0) throw new RecurringError("Abo hat keine Positionen.");

    const periodDate = rec.nextRunDate;

    // Positionen 1:1 aus dem Abo — RecurringInvoiceLine kennt keine Gliederungszeilen,
    // lineType bleibt immer ITEM. Netto-/Steuerberechnung (inkl. der W4-Rundung ueber
    // computeLineNet) uebernimmt ab jetzt createDraftInvoiceWithinTx — kein zweiter,
    // separat gerechneter Block mehr.
    const lines: CreateInvoiceInput["lines"] = rec.lines.map((l) => ({
      lineType: "ITEM",
      description: l.description,
      quantityMilli: l.quantityMilli,
      unit: l.unit,
      unitNetPriceCents: l.unitNetPriceCents,
      taxRate: l.taxRate,
      taxCategory: l.taxCategory as CreateInvoiceInput["lines"][number]["taxCategory"],
      discountPermille: l.discountPermille,
      discountCents: 0,
    }));

    // recurringInsertPeriodText (Phase 7, §33): Kopftext "Abrechnungszeitraum dd.mm.yyyy –
    // dd.mm.yyyy", nur wenn die Org-Einstellung aktiv ist. R4/R5 (Phase 14a, §43a):
    // bei aktivem Text zusaetzlich BG-14 setzen (deliveryStart/deliveryEnd = Perioden-
    // grenzen, derselbe Zeitraum wie im Kopftext) — ist er aus, bleibt headerText
    // undefined, damit die INVOICE-HEAD-Textvorlage greift (createDraftInvoiceWithinTx).
    let headerText: string | undefined;
    let deliveryStart: Date | undefined;
    let deliveryEnd: Date | undefined;
    // showPeriodText (Phase 8b, §43): das Abo-Feld ist ab jetzt allein massgeblich — der
    // Settings-Default (recurringInsertPeriodText) wird nur noch beim Anlegen des Abos
    // uebernommen (createRecurring), nicht mehr live bei jedem Lauf gelesen.
    if (rec.showPeriodText) {
      const { start } = periodRange(periodDate, rec.interval as RecurInterval, rec.intervalCount, rec.anchorDay);
      headerText = `Abrechnungszeitraum ${formatDateDe(start)} – ${formatDateDe(periodDate)}`;
      deliveryStart = start;
      deliveryEnd = periodDate;
    }

    // R1 (Spec Phase 14a): Felder, die das Abo selbst fuehrt (taxScheme, currency, notes,
    // Positionen, Faelligkeit via explizitem dueDate), gewinnen immer. Alles, was das Abo
    // NICHT fuehrt (paymentMethodId, contactPersonId, billingAddressId, shippingAddressId,
    // documentDiscountPermille/Cents, orderNumber, paymentTerms, headerText/footerText ohne
    // Zeitraumtext), bleibt hier bewusst undefined — createDraftInvoiceWithinTx zieht dafuer
    // die jeweilige Kundenvorgabe (§28-§30).
    const input: CreateInvoiceInput = {
      customerId: rec.customerId,
      type: "INVOICE",
      taxScheme: rec.taxScheme as CreateInvoiceInput["taxScheme"],
      currency: rec.currency,
      issueDate: now,
      deliveryDate: periodDate,
      deliveryStart,
      deliveryEnd,
      // dueDate EXPLIZIT aus der Abo-Zusage (rec.paymentTermsDays) uebergeben — sonst
      // wuerde Customer.defaultPaymentTermsDays diese ausdrueckliche Abo-Zusage in
      // createDraftInvoiceWithinTx stillschweigend ueberstimmen (R1).
      dueDate: new Date(now.getTime() + rec.paymentTermsDays * DAY_MS),
      notes: rec.notes ?? undefined,
      headerText,
      // documentChargePermille/-Cents haben in createInvoiceSchema ein `.default(0)` und
      // sind im Output-Typ deshalb Pflichtfelder — das Abo kennt keinen Belegaufschlag.
      documentChargePermille: 0,
      documentChargeCents: 0,
      lines,
    };

    const invoice = await createDraftInvoiceWithinTx(tx, rec.orgId, input, {
      actor,
      now,
      // R3: der/die im Abo verwendete(n) Steuersatz/-saetze gilt/gelten zusaetzlich als
      // erlaubt, auch wenn er/sie inzwischen aus der Org-Liste entfernt wurde(n) —
      // dasselbe Muster wie Duplikat/Konvertierung/Teilrechnung (Phase 12c), kein Bypass.
      // Sonst wuerde ein Bestandsabo mit inzwischen abgewaehltem Satz am Lauf scheitern.
      inheritedTaxRates: ratesOfLines(rec.lines),
      recurringInvoiceId: rec.id,
      // Abo-Kontext (recurring, period) im selben ChangeLog-CREATE-Eintrag UND im selben
      // ActivityLog-CREATED-Eintrag wie der gemeinsame Pfad (Fix-Welle 1, must) — kein
      // zweiter Eintrag je erzeugter Rechnung, in keinem der beiden Protokolle.
      changeLogExtra: { recurring: rec.id, period: periodDate.toISOString() },
    });

    await linkDocuments(tx, { orgId: rec.orgId, fromType: "INVOICE", fromId: invoice.id, toType: "RECURRING", toId: rec.id, relationType: "GENERATED_BY" });

    let number: string | null = invoice.number;
    let finalized = false;
    if (rec.autoFinalize) {
      const fin = await finalizeWithinTx(tx, invoice.id, { now, actor });
      number = fin.number;
      finalized = true;
    }

    const next = advanceDate(periodDate, rec.interval as RecurInterval, rec.intervalCount, rec.anchorDay);
    // issuedCount VOR dem Erhoehen im naechsten Schritt ist die Anzahl der bereits
    // vorherigen Laeufe — nach DIESEM Lauf steht die Anzahl bei issuedCount + 1
    // (Task-1-Brief: "maxRuns -> ENDED wenn issuedCount >= maxRuns NACH Lauf").
    const issuedCountAfter = rec.issuedCount + 1;
    const endedByDate = rec.endDate ? next > rec.endDate : false;
    const endedByMaxRuns = rec.maxRuns != null && issuedCountAfter >= rec.maxRuns;
    const ended = endedByDate || endedByMaxRuns;
    await tx.recurringInvoice.update({
      where: { id: rec.id },
      data: {
        nextRunDate: next,
        lastRunAt: now,
        issuedCount: { increment: 1 },
        status: ended ? "ENDED" : "ACTIVE",
      },
    });

    const result: EmittedInvoice = { invoiceId: invoice.id, number, periodDate, finalized };
    return { result, ended, autoSend: rec.autoSend, orgId: rec.orgId, emailTemplateId: rec.emailTemplateId };
  });

  // autoSend (Phase 7, §33): erst NACH der Transaktion versenden (Modulkommentar: kein
  // SMTP-Aufruf innerhalb einer Prisma-Transaktion). Ein Fehler beim Versand darf die
  // bereits erzeugte/festgeschriebene Rechnung nicht rueckabwickeln — er landet im Feld
  // `emailStatus`/`emailError` des Ergebnisses (Summary), niemals als geworfener Fehler.
  // S4 (Fix-Welle, Final-Review): zusaetzlich zu `autoSend` MUSS die Rechnung tatsaechlich
  // festgeschrieben sein (createRecurring erzwingt zwar autoFinalize bei autoSend, aber
  // ein Bestandsdatensatz aus der Zeit vor diesem Fix koennte autoSend=true/autoFinalize=false
  // noch kombiniert haben) — sonst ginge eine Rechnung mit Nummer/GiroCode "ENTWURF" raus.
  if (created.autoSend && created.result.finalized) {
    const sent = await sendRecurringInvoiceEmail(created.orgId, created.result.invoiceId, provider, created.emailTemplateId);
    created.result.emailStatus = sent.status;
    created.result.emailError = sent.error;
  }

  return created;
}

/** Manuell: erzeugt sofort die nächste fällige Rechnung eines Abos (ignoriert den Stichtag). */
export async function emitRecurringNow(recurringId: string, opts: RunOptions = {}): Promise<EmittedInvoice> {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? "system";
  const { result } = await emitOne(recurringId, now, actor, opts.provider);
  return result;
}

export interface RecurringRunSummary {
  recurringId: string;
  title: string;
  emitted: EmittedInvoice[];
  /** Fehlermeldung, falls der Lauf dieses Abos abgebrochen ist (Task-3-Ergaenzung: Fehler-
   *  Summary). Bereits erzeugte `emitted`-Eintraege bleiben gueltig — nur der naechste
   *  (fehlgeschlagene) Versuch dieses Abos wurde abgebrochen. */
  error?: string;
}

/**
 * Batch-Lauf (Cron): erzeugt für alle ACTIVE-Abos mit `nextRunDate <= now` die
 * fälligen Rechnungen — bei Rückstand mehrere, gedeckelt durch `maxPerAbo`.
 *
 * Fehler-Summary (Phase 8b, Task 3): ein Fehler beim Erzeugen EINES Abo-Laufs (z. B.
 * fehlende Pflichtangaben beim `autoFinalize`) brach frueher den GESAMTEN Batch ab — kein
 * try/catch um `emitOne`, ein einziges kaputtes Abo verhinderte die Rechnungen ALLER
 * anderen faelligen Abos in diesem Lauf. Jetzt: Fehler landen in `RecurringRunSummary.error`,
 * die Schleife faehrt mit dem naechsten Abo fort; `onRecurringFailed`
 * (`src/domain/notifications/hooks.ts`) benachrichtigt zusaetzlich die Organisation.
 */
export async function runDueRecurring(
  opts: RunOptions & { orgId?: string; maxPerAbo?: number } = {},
): Promise<RecurringRunSummary[]> {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? "recurring-runner";
  const max = opts.maxPerAbo ?? 24;

  const due = await dbInternal.recurringInvoice.findMany({
    where: { status: "ACTIVE", nextRunDate: { lte: now }, ...(opts.orgId ? { orgId: opts.orgId } : {}) },
    select: { id: true, title: true, orgId: true },
    orderBy: { nextRunDate: "asc" },
  });

  const summaries: RecurringRunSummary[] = [];
  for (const rec of due) {
    const emitted: EmittedInvoice[] = [];
    let error: string | undefined;
    try {
      for (let i = 0; i < max; i++) {
        const cur = await dbInternal.recurringInvoice.findUnique({
          where: { id: rec.id },
          select: { status: true, nextRunDate: true },
        });
        if (!cur || cur.status !== "ACTIVE" || cur.nextRunDate > now) break;
        const { result, ended } = await emitOne(rec.id, now, actor, opts.provider);
        emitted.push(result);
        if (ended) break;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      await onRecurringFailed(rec.orgId, { recurringId: rec.id, title: rec.title, message: error, at: now });
    }
    summaries.push({ recurringId: rec.id, title: rec.title, emitted, ...(error ? { error } : {}) });
  }
  return summaries;
}
