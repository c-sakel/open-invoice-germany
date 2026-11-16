"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { acceptInboundAction, acceptInboundBatchAction, discardInboundAction, restoreInboundAction } from "@/app/eingang/postfach/actions";
import { Button } from "@/components/ui/Button";
import { inputCls } from "@/components/forms/fields";
import { formatReceivedAt, sizeLabel } from "@/components/incoming/incoming-ui";
import { UI_MAX_ACCEPT_BATCH as MAX_ACCEPT_BATCH, PREVIEW_CAVEAT, previewAmount, previewKindLabel, skipText, toPreviewView, type InboxTab } from "./mailbox-ui";

export interface InboundRowView {
  id: string;
  status: string;
  fileName: string;
  size: number;
  mailDate: string | null;
  fetchedAt: string;
  senderDomain: string | null;
  subject: string | null;
  preview: unknown;
  incomingInvoiceId: string | null;
  duplicateOfIncomingId: string | null;
  decidedAt: string | null;
  discardReason: string | null;
  purged: boolean;
  /** Letzter Tag der Wiederherstellung (ISO), nur bei verworfenen Anlagen. */
  restoreUntil: string | null;
  skipReason: string | null;
}

function dayLabel(iso: string | null): string {
  return iso === null ? "–" : formatReceivedAt(iso).split(",")[0] ?? "–";
}

function Row({ row, tab, selected, onToggle, onDone, onMessage }: { row: InboundRowView; tab: InboxTab; selected: boolean; onToggle: () => void; onDone: () => void; onMessage: (m: string | null, failed: boolean) => void }) {
  const [pending, start] = useTransition();
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  const preview = toPreviewView(row.preview);

  function act(fn: () => Promise<{ ok: boolean; error?: string }>, doneText: string) {
    onMessage(null, false);
    start(async () => {
      const r = await fn();
      if (r.ok) {
        onMessage(doneText, false);
        onDone();
      } else {
        onMessage(r.error ?? "Die Aktion konnte nicht ausgeführt werden.", true);
      }
    });
  }

  return (
    <li className="rounded-md border border-rule bg-sheet p-3 text-sm">
      <div className="flex items-start gap-3">
        {tab === "INBOX" ? (
          <input type="checkbox" className="mt-1 h-4 w-4 shrink-0" checked={selected} onChange={onToggle} aria-label={`${row.fileName} auswählen`} />
        ) : null}
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium text-ink [overflow-wrap:anywhere]">{row.fileName}</p>
          <p className="text-ink-soft [overflow-wrap:anywhere]">Betreff: {row.subject ?? "–"}</p>
          <p className="text-xs text-ink-muted [overflow-wrap:anywhere]">
            Eingang {formatReceivedAt(row.mailDate ?? row.fetchedAt)} · Absender-Domain {row.senderDomain ?? "–"} (Angabe der Mail, nicht geprüft) · {sizeLabel(row.size)}
          </p>
          {preview ? (
            <p className="text-xs text-ink-soft [overflow-wrap:anywhere]">
              <span className="font-medium">{previewKindLabel(preview)}</span>
              {preview.number ? ` · Nummer ${preview.number}` : ""}
              {preview.supplierName ? ` · ${preview.supplierName}` : ""}
              {preview.grossCents !== null ? ` · ${previewAmount(preview)}` : ""}
              <span className="ml-1 text-ink-muted">({PREVIEW_CAVEAT})</span>
            </p>
          ) : null}
          {row.status === "SKIPPED" ? <p className="text-xs text-ink-muted">Übersprungen: {skipText(row.skipReason)}</p> : null}
          {row.status === "DUPLICATE" ? (
            <p className="text-xs text-ink-muted">
              Dublette
              {row.duplicateOfIncomingId ? (
                <>
                  {" "}
                  von{" "}
                  <Link href={`/eingang/${row.duplicateOfIncomingId}`} className="underline">
                    Eingangsrechnung
                  </Link>
                </>
              ) : null}
            </p>
          ) : null}
          {row.status === "ACCEPTED" && row.incomingInvoiceId ? (
            <p className="text-xs">
              <Link href={`/eingang/${row.incomingInvoiceId}`} className="underline">
                Zur Eingangsrechnung
              </Link>
              <span className="ml-2 text-ink-muted">übernommen {dayLabel(row.decidedAt)}</span>
            </p>
          ) : null}
          {row.status === "DISCARDED" ? (
            <p className="text-xs text-ink-muted [overflow-wrap:anywhere]">
              Verworfen {dayLabel(row.decidedAt)}
              {row.discardReason ? `: ${row.discardReason}` : ""}
              {row.purged ? " · Kopie entfernt, nicht mehr wiederherstellbar" : row.restoreUntil ? ` · wiederherstellbar bis ${dayLabel(row.restoreUntil)}` : ""}
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-2 pl-0 sm:pl-7">
        {(row.status === "INBOX" || (row.status === "DISCARDED" && !row.purged)) && (
          <a href={`/api/inbound-mail/${row.id}/file`} className="inline-flex min-h-9 items-center rounded-md border border-rule-strong px-3 py-1 text-[13px] text-ink-soft hover:bg-paper">
            Datei laden
          </a>
        )}
        {row.status === "INBOX" ? (
          <>
            <Button type="button" variant="primary" size="sm" disabled={pending} onClick={() => act(() => acceptInboundAction(row.id), "Übernommen.")}>
              Übernehmen
            </Button>
            <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => setReasonOpen((v) => !v)}>
              Verwerfen
            </Button>
          </>
        ) : null}
        {row.status === "DISCARDED" && !row.purged ? (
          <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => act(() => restoreInboundAction(row.id), "Wiederhergestellt.")}>
            Wiederherstellen
          </Button>
        ) : null}
      </div>

      {reasonOpen && row.status === "INBOX" ? (
        <div className="mt-2 flex flex-wrap items-end gap-2 sm:pl-7">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
            <span className="text-ink-soft">Grund (optional)</span>
            <input className={`${inputCls} w-full min-w-0`} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          </label>
          <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => act(() => discardInboundAction(row.id, reason.trim() === "" ? null : reason), "Verworfen.")}>
            Verwerfen bestätigen
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/** Sichtung der Postfach-Anlagen. Texte aus Mails und Dateien erscheinen nur als Text; es gibt keine Löschfunktion. */
export function InboundMailList({ rows, tab }: { rows: InboundRowView[]; tab: InboxTab }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_ACCEPT_BATCH) next.add(id);
      return next;
    });
  }

  function acceptSelected() {
    setMessage(null);
    const ids = [...selected];
    start(async () => {
      const r = await acceptInboundBatchAction(ids);
      if (!r.ok) {
        setMessage({ text: r.error, failed: true });
        return;
      }
      const okCount = r.data.entries.filter((e) => e.ok).length;
      const failedEntries = r.data.entries.filter((e) => !e.ok);
      setMessage({
        text: `${okCount} übernommen${failedEntries.length > 0 ? `, ${failedEntries.length} nicht möglich: ${[...new Set(failedEntries.map((e) => e.error ?? ""))].join(" ")}` : "."}`,
        failed: failedEntries.length > 0,
      });
      setSelected(new Set());
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      {message ? (
        <p role={message.failed ? "alert" : "status"} className={`text-sm ${message.failed ? "text-red-900" : "text-ledger"}`}>
          {message.text}
        </p>
      ) : null}
      {tab === "INBOX" && rows.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Button type="button" variant="primary" size="sm" disabled={pending || selected.size === 0} onClick={acceptSelected}>
            Ausgewählte übernehmen ({selected.size})
          </Button>
          <span className="text-xs text-ink-muted">Höchstens {MAX_ACCEPT_BATCH} auf einmal.</span>
        </div>
      ) : null}
      {rows.length === 0 ? (
        <p className="rounded-md border border-rule bg-paper px-3 py-6 text-center text-sm text-ink-muted">Keine Anlagen in dieser Ansicht.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <Row
              key={r.id}
              row={r}
              tab={tab}
              selected={selected.has(r.id)}
              onToggle={() => toggle(r.id)}
              onDone={() => router.refresh()}
              onMessage={(text, failed) => setMessage(text === null ? null : { text, failed })}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
