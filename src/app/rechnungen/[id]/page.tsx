import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma, dbInternal } from "@/lib/db";
import { getActiveOrg } from "@/lib/org";
import { formatCents } from "@/lib/money";
import { StatusBadge } from "@/components/StatusBadge";
import { finalizeAction } from "@/app/actions/invoices";
import { dunningScheduleFor, latestDunning, reachedStageIds } from "@/domain/dunning/schedule";
import { loadDunningSettings } from "@/domain/dunning/settings";
import { listPaymentMethods } from "@/domain/payment-method/manage";
import { SendEmailDialog } from "@/components/SendEmailDialog";
import { EmailHistory } from "@/components/EmailHistory";
import { DocumentChain } from "@/components/DocumentChain";
import { AttachmentPanel } from "@/components/AttachmentPanel";
import { listAttachments } from "@/domain/attachment/manage";
import { LineItemsTable } from "@/components/LineItemsTable";
import { BelegStrecke } from "@/components/BelegStrecke";
import { belegStrecke } from "@/domain/timeline/belegstrecke";
import { DetailSection } from "@/components/detail/DetailSection";
import { DocumentTimeline } from "@/components/DocumentTimeline";
import { DocumentDetailLayout } from "@/components/detail/DocumentDetailLayout";
import { DetailNav } from "@/components/detail/DetailNav";
import { PdfStack } from "@/components/detail/PdfStack";
import { CollapsibleSection } from "@/components/detail/CollapsibleSection";
import { InternalNotesBox } from "@/components/detail/InternalNotesBox";
import { loadNeighbors } from "@/domain/document/neighbors";
import { listTags } from "@/domain/tag/manage";
import { tagsForDocuments } from "@/domain/tag/list";
import { refundablePaidCents } from "@/domain/invoice/amounts";
import { buildInvoiceViewModel, primaryAction, TYPE_TITLE } from "./_parts/invoice-view-model";
import { InvoiceStatusCard } from "./_parts/InvoiceStatusCard";
import { InvoiceMoreMenu } from "./_parts/InvoiceMoreMenu";
import { InvoiceTotals } from "./_parts/InvoiceTotals";
import { CorrectionSection } from "./_parts/CorrectionSection";
import { PaymentSection } from "./_parts/PaymentSection";
import { finalizeWarningMessage, parseWarningCodes } from "@/domain/invoice/finalize-warnings";
import { normalizeVatId } from "@/lib/vat-id";

export const dynamic = "force-dynamic";

// Phase 13c, Task 4: Klassen der Primaer-/Sekundaeraktion in der Kopfzeile — dieselben
// Farben wie die bisherigen Einzelknoepfe (PDF/Bearbeiten sekundaer, Festschreiben primaer).
const primaryBtnCls = "rounded-md bg-pen px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-pen-strong";
const secondaryBtnCls = "rounded-md border border-rule-strong bg-sheet px-3 py-1.5 text-sm font-medium text-ink-soft hover:bg-paper";

export default async function InvoiceDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; hinweis?: string; send?: string; liste?: string | string[] }>;
}) {
  const { id } = await params;
  const { error, hinweis, send, liste: listeParam } = await searchParams;
  const hinweisCodes = parseWarningCodes(hinweis);
  const liste = firstOf(listeParam);

  const org = await getActiveOrg();
  // G7 (Fix-Runde 2): findUnique(id) ohne orgId erlaubte fremden Organisationen den Zugriff
  // auf eine Rechnungsseite ueber die reine ID — jetzt mandantengeprueft.
  const invoice = await prisma.invoice.findFirst({
    where: { id, orgId: org.id },
    include: {
      lines: { orderBy: { position: "asc" } },
      customer: { include: { defaultPaymentMethod: true } },
      org: true,
      payments: { orderBy: { paidAt: "asc" } },
      dunnings: { orderBy: { level: "asc" }, include: { stage: { select: { order: true, name: true } } } },
      paymentMethod: true,
      // Task 4: Abzugs-Snapshot einer Schlussrechnung (Task 2, FinalInvoiceDeduction) —
      // NIE live aus den Abschlagsrechnungen, nur dieser unveraenderliche Snapshot.
      finalDeductions: { orderBy: { issueDate: "asc" } },
    },
  });
  if (!invoice) notFound();

  const vm = buildInvoiceViewModel(invoice);
  const archive = await prisma.archivedDocument.findFirst({
    where: { invoiceId: invoice.id, kind: "PDF", invoice: { orgId: org.id } },
    select: { createdAt: true, sha256: true },
  });
  // T7: nach einem Storno zurueckzuzahlender Betrag = echte Zahlungen (ohne Verrechnungen mit Teilgutschriften).
  const refundDueCents = vm.isCancelled
    ? refundablePaidCents(invoice.payments)
    : 0;
  // Phase 13c, Task 4: genau EINE hervorgehobene Kopfzeilen-Aktion je Status statt bis zu
  // fuenf gleichwertigen Knoepfen — reine Ableitung aus dem View-Model (primaryAction).
  const primary = primaryAction(vm);

  // Task 4: Bezug zur Quelle (Angebot/AB bzw. Lieferschein) bei PARTIAL/DOWNPAYMENT/FINAL.
  let sourceLabel: { href: string; text: string } | null = null;
  if (invoice.sourceType === "QUOTE" && invoice.sourceId) {
    const src = await prisma.quote.findFirst({ where: { id: invoice.sourceId, orgId: org.id }, select: { number: true, kind: true } });
    if (src) {
      const kindLabel = src.kind === "AUFTRAGSBESTAETIGUNG" ? "Auftragsbestätigung" : src.kind === "PROFORMA" ? "Proforma-Rechnung" : "Angebot";
      sourceLabel = { href: `/dokumente/${invoice.sourceId}`, text: `${kindLabel} ${src.number ?? ""}`.trim() };
    }
  } else if (invoice.sourceType === "DELIVERY_NOTE" && invoice.sourceId) {
    const src = await prisma.deliveryNote.findFirst({ where: { id: invoice.sourceId, orgId: org.id }, select: { number: true } });
    if (src) sourceLabel = { href: `/lieferscheine/${invoice.sourceId}`, text: `Lieferschein ${src.number ?? ""}`.trim() };
  }

  // Task 4: Mahnblock — naechste Stufe/Faelligkeit ueber dieselbe reine Zeitplan-Logik
  // wie createDunning (dunningScheduleFor), damit die Anzeige exakt dem entspricht, was
  // die naechste Erstellung tatsaechlich anwenden wuerde.
  let dunningSchedule: { nextStage: { name: string; order: number } | null; dueAt: Date | null; isDue: boolean } | null = null;
  if (vm.openCents > 0 && !vm.isDraft && !vm.isCancelled) {
    const dunningStages = await prisma.dunningStage.findMany({ where: { orgId: org.id }, select: { id: true, order: true, enabled: true, daysAfterDue: true, name: true } });
    const dunningSettings = await loadDunningSettings(org.id);
    // Nit (Fix-Welle): `latestDunning` statt "letztes Element nach orderBy level asc" —
    // nach einem Umsortieren der Mahnstufen (S3) ist `level`/`stage.order` nicht mehr
    // zuverlaessig die zeitliche Reihenfolge; einheitlich mit create.ts/auto.ts.
    const lastDunning = latestDunning(invoice.dunnings);
    const schedule = dunningScheduleFor({
      invoiceDueDate: vm.dueDate,
      lastDunning: lastDunning ? { order: lastDunning.stage?.order ?? lastDunning.level, dueDate: lastDunning.dueDate, sentAt: lastDunning.sentAt } : null,
      stages: dunningStages,
      reachedStageIds: reachedStageIds(invoice.dunnings),
      gracePeriodDays: dunningSettings.gracePeriodDays,
      now: new Date(),
    });
    dunningSchedule = { nextStage: schedule.nextStage ? { name: schedule.nextStage.name, order: schedule.nextStage.order } : null, dueAt: schedule.dueAt, isDue: schedule.isDue };
  }

  // Zahlungsmethoden-Auswahl im Zahlungsdialog: aktive Methoden OHNE den Systemcode SKONTO
  // (der wird ausschliesslich automatisch bei detectSkonto gebucht, nie manuell gewaehlt).
  // Default-Kette: Kunden-Standard -> Methode der Rechnung -> TRANSFER.
  const activePaymentMethods = vm.canPay
    ? (await listPaymentMethods(org.id)).filter((m) => m.isActive && m.code !== "SKONTO")
    : [];
  const defaultPaymentMethodCode = invoice.customer.defaultPaymentMethod?.code ?? invoice.paymentMethod?.code ?? "TRANSFER";

  const attachments = await listAttachments(org.id, "INVOICE", invoice.id);

  // Phase 13d, Task 4 (Fix-Welle 1, should 5: jetzt Details-Karte statt nav-Slot): Tags
  // dieses Belegs plus die volle Tag-Liste der Organisation (Auswahlfeld in TagPicker).
  const [allTags, docTags] = await Promise.all([listTags(org.id), tagsForDocuments(org.id, "INVOICE", [invoice.id])]);
  const invoiceTags = docTags.get(invoice.id) ?? [];

  // S6 (Fix-Welle 1, Spec C "Detail-Layout"): "versendet am + Kanal" in der Details-Karte —
  // aus dem juengsten EmailLog-Eintrag, kein neues Feld auf Invoice. "Kanal" ist bislang
  // immer E-Mail (einziger Versandweg dieser Software), daher statisch angehaengt.
  const lastEmailLog = await dbInternal.emailLog.findFirst({
    where: { orgId: org.id, docType: vm.emailDocType, docId: invoice.id, status: { in: ["SENT", "DELIVERED"] } },
    orderBy: { createdAt: "desc" },
    select: { sentAt: true, createdAt: true },
  });
  const lastSentAt = lastEmailLog?.sentAt ?? lastEmailLog?.createdAt ?? null;
  // Belegstrecke: "versendet" = es gibt einen erfolgreichen E-Mail-Eintrag (Zeitstrahl `email`) oder Status SENT.
  const steps = belegStrecke({
    status: invoice.status,
    sent: lastEmailLog !== null || invoice.status === "SENT",
    paidAmountCents: invoice.paidAmountCents,
    payableCents: invoice.payableCents ?? invoice.grossTotalCents,
  });

  const { prevId, nextId, backQuery } = await loadNeighbors("INVOICE", org.id, id, liste);
  const navHref = (targetId: string) => `/rechnungen/${targetId}${liste ? `?liste=${encodeURIComponent(liste)}` : ""}`;

  const title = `${TYPE_TITLE[invoice.type] ?? "Beleg"} ${invoice.number ?? "(Entwurf)"}`;
  const showPaymentBlock = vm.isInvoiceType && !vm.isDraft && !vm.isCancelled;
  // Zahlungsliste (inkl. Gegenbuchung) auch bei stornierten Rechnungen; PaymentDialog bleibt ueber canPay aus.
  const showPaymentList = vm.isInvoiceType && !vm.isDraft;
  // Abschnitt "Zahlung & Mahnung" nur, wenn PaymentSection etwas rendert (sonst stuende eine leere Ueberschrift).
  const showPayment = showPaymentBlock && ((vm.openCents > 0 && dunningSchedule != null) || invoice.dunnings.length > 0);
  const showCorrection = !vm.isDraft && !vm.isCancelled;

  return (
    <DocumentDetailLayout
      nav={
        <DetailNav
          backHref={`/rechnungen${backQuery ? `?${backQuery}` : ""}`}
          backLabel="Rechnungen"
          prevHref={prevId ? navHref(prevId) : null}
          nextHref={nextId ? navHref(nextId) : null}
        />
      }
      title={title}
      badges={
        <>
          <StatusBadge status={invoice.status} />
          {sourceLabel && (
            <Link href={sourceLabel.href} className="text-sm text-pen hover:underline">
              zu {sourceLabel.text}
            </Link>
          )}
          {invoice.snapshotSource === "MIGRATION" && (
            <span className="inline-block rounded bg-seal/10 px-2 py-0.5 text-xs font-medium text-seal">
              Adressstand per Migration eingefroren
            </span>
          )}
        </>
      }
      actions={
        <>
          {/* I1 (Fix-Welle): PDF-Knopf wie auf Dokument-/Lieferscheinseite — rendert auch Entwuerfe. */}
          <a href={`/api/invoices/${invoice.id}/pdf`} target="_blank" className="rounded-md border border-rule-strong bg-sheet px-3 py-1.5 text-sm font-medium text-ink-soft hover:bg-paper">
            PDF
          </a>
          <SendEmailDialog docType={vm.emailDocType} docId={invoice.id} label={vm.isDraft ? "Entwurf per E-Mail senden" : "Per E-Mail senden"} autoOpen={send === "1" && invoice.type === "CREDIT_NOTE"} />
          {vm.isDraft && (
            <Link href={`/rechnungen/${invoice.id}/bearbeiten`} className="rounded-md border border-rule-strong bg-sheet px-3 py-1.5 text-sm font-medium text-ink-soft hover:bg-paper">
              Bearbeiten
            </Link>
          )}
          {/* Primaeraktion (Task 4): Entwurf -> Festschreiben, offen -> Als bezahlt markieren
              (oeffnet den einen PaymentDialog in InvoiceStatusCard ueber den weiterhin
              gueltigen Anker #zahlung — keine zweite Dialog-Instanz hier), sonst Neue
              Rechnung. "Neue Rechnung" steht zusaetzlich IMMER als sekundaerer Link zur
              Verfuegung, ausser er ist bereits die Primaeraktion (kein doppelter Knopf). */}
          {primary.kind === "FINALIZE" && (
            <form action={finalizeAction}>
              <input type="hidden" name="id" value={invoice.id} />
              <button className={primaryBtnCls}>{primary.label}</button>
            </form>
          )}
          {primary.kind === "PAY" && (
            <a href="#zahlung" className={primaryBtnCls}>
              {primary.label}
            </a>
          )}
          <Link
            href={`/rechnungen/neu?customerId=${invoice.customer.id}`}
            className={primary.kind === "NEW_INVOICE" ? primaryBtnCls : secondaryBtnCls}
          >
            {primary.kind === "NEW_INVOICE" ? primary.label : "Neue Rechnung"}
          </Link>
        </>
      }
      more={
        <InvoiceMoreMenu
          invoiceId={invoice.id}
          isDraft={vm.isDraft}
          isCancelled={vm.isCancelled}
          isInvoiceType={vm.isInvoiceType}
          canCancelOrCredit={vm.canCancelOrCredit}
          canDuplicate={vm.canDuplicate}
          canSaveTemplate={vm.actions.includes("TEMPLATE_SAVE")}
          templateName={invoice.number ?? undefined}
        />
      }
      notice={
        <>
          {vm.isInvoiceType && (
            <div className="rounded-[var(--radius-card)] bg-sheet px-4 py-3 shadow-[var(--shadow-card)]">
              <BelegStrecke steps={steps} size="lg" />
            </div>
          )}
          {error && <div className="rounded-md border border-stamp/30 bg-stamp/10 p-4 text-sm whitespace-pre-line text-stamp">{error}</div>}
          {hinweisCodes.length > 0 && (
            <div role="status" className="rounded-md border border-rule bg-paper p-3 text-sm whitespace-pre-line text-ink-soft">
              <strong className="font-medium">Hinweis zum Festschreiben:</strong>{"\n"}{hinweisCodes.map((c) => finalizeWarningMessage(c, normalizeVatId(invoice.customer.vatId ?? ""))).join("\n")}
            </div>
          )}
          {vm.isCancelled && refundDueCents > 0 && (
            <div className="rounded-md border border-rule bg-paper p-3 text-sm text-ink-soft">
              Erfasste Zahlungen: {formatCents(refundDueCents, invoice.currency)} — falls noch nicht geschehen, an den Kunden zurückzahlen (Skonto und Verrechnungen mit Gutschriften sind nicht enthalten).
            </div>
          )}
          {vm.isDraft && (
            <div className="rounded-md border border-seal/30 bg-seal/10 p-3 text-sm text-seal">
              Entwurf — noch keine Rechnungsnummer vergeben. Mit „Festschreiben“ wird die Rechnung GoBD-konform unveränderbar.
            </div>
          )}
        </>
      }
      pdf={<PdfStack src={`/api/invoices/${invoice.id}/pdf`} title={`${title} — PDF`} />}
      aside={
        <>
          <InvoiceStatusCard
            invoice={invoice}
            openCents={vm.openCents}
            isOverdue={vm.isOverdue}
            paymentMethodName={vm.paymentMethodName}
            hasSkonto={vm.hasSkonto}
            showPaymentBlock={showPaymentBlock}
            showPaymentList={showPaymentList}
            canPay={vm.canPay}
            paymentMethods={activePaymentMethods.map((m) => ({ code: m.code, name: m.name }))}
            defaultPaymentMethod={defaultPaymentMethodCode}
            lastSentAt={lastSentAt}
            tags={invoiceTags}
            tagOptions={allTags}
            archive={archive}
          />
          <AttachmentPanel
            docType="INVOICE"
            docId={invoice.id}
            initial={attachments.map((a) => ({ id: a.id, filename: a.filename, mime: a.mime, sizeBytes: a.sizeBytes }))}
          />
          <DocumentChain orgId={org.id} type="INVOICE" id={invoice.id} />
        </>
      }
    >
      <DetailSection id="beleg" title="Beleg">
        <InternalNotesBox notes={invoice.internalNotes} />

        <CollapsibleSection title="Positionen" summary={`${invoice.lines.length} ${invoice.lines.length === 1 ? "Position" : "Positionen"} · Netto ${formatCents(invoice.netTotalCents, invoice.currency)}`}>
          <div className="space-y-4">
            {invoice.headerText && <p className="whitespace-pre-line text-sm text-ink-soft">{invoice.headerText}</p>}
            <LineItemsTable lines={invoice.lines} currency={invoice.currency} />
            <InvoiceTotals
              currency={invoice.currency}
              type={invoice.type}
              hasDocumentAdjustment={vm.hasDocumentAdjustment}
              documentDiscountTotalCents={vm.documentDiscountTotalCents}
              documentChargeTotalCents={vm.documentChargeTotalCents}
              documentChargeReason={invoice.documentChargeReason}
              netTotalCents={invoice.netTotalCents}
              breakdown={vm.breakdown}
              grossTotalCents={invoice.grossTotalCents}
              payableBase={vm.payableBase}
              deductionsByInvoice={vm.deductionsByInvoice}
            />
            {invoice.footerText && <p className="whitespace-pre-line text-sm text-ink-soft">{invoice.footerText}</p>}
            {invoice.notes && <p className="text-sm text-ink-soft">{invoice.notes}</p>}
          </div>
        </CollapsibleSection>
      </DetailSection>

      {/* S7 (Fix-Welle 1, Spec C "Detail-Layout"): Mahnblock bleibt unter der Vorschau (volle
          Breite) statt sich in der 24rem-Statuskartenspalte einzuquetschen — PaymentSection
          rendert bei Bedarf selbst nichts, wenn weder ein faelliger Mahnschritt noch bereits
          verschickte Mahnungen vorliegen. */}
      {showPayment && (
        <DetailSection id="zahlung" title="Zahlung &amp; Mahnung">
          <PaymentSection
            invoiceId={invoice.id}
            currency={invoice.currency}
            openCents={vm.openCents}
            isOverdue={vm.isOverdue}
            dueDate={vm.dueDate}
            dunningState={invoice.dunningState as "ACTIVE" | "PAUSED" | "STOPPED"}
            dunningPausedUntil={invoice.dunningPausedUntil}
            dunningSchedule={dunningSchedule}
            dunnings={invoice.dunnings}
          />
        </DetailSection>
      )}

      {showCorrection && (
        <DetailSection id="korrektur" title="Korrektur">
          <CorrectionSection invoiceId={invoice.id} type={invoice.type} canCancelOrCredit={vm.canCancelOrCredit} canDuplicate={vm.canDuplicate} />
        </DetailSection>
      )}

      <DetailSection id="verlauf" title="Verlauf">
        <EmailHistory docType={vm.emailDocType} docId={invoice.id} />
        <DocumentTimeline kind="INVOICE" docId={invoice.id} />
      </DetailSection>
    </DocumentDetailLayout>
  );
}

// M11 (Fix-Welle): `?liste=a&liste=b` liefert `string[]` — Ableitung wie auf den Listenseiten.
function firstOf(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
