"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createPortalLinkAction,
  revealPortalUrlAction,
  revokePortalLinkAction,
  sendPortalLinkAction,
} from "@/app/kunden/[id]/portal-actions";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog, type ConfirmDialogHandle } from "@/components/ui/ConfirmDialog";
import { inputCls, ErrorBanner } from "@/components/forms/fields";

export interface PortalLinkCardLink {
  active: boolean;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastViewedAt: string | null;
  viewCount: number;
}

export interface PortalLinkCardEvent {
  id: string;
  at: string;
  kind: string;
  fileKind: string | null;
  docNumber: string | null;
}

export interface PortalLinkCardProps {
  customerId: string;
  portalEnabled: boolean;
  customerArchived: boolean;
  link: PortalLinkCardLink | null;
  events: PortalLinkCardEvent[];
  defaultRecipient: string;
}

function deDate(iso: string): string {
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: "Europe/Berlin" }).format(new Date(iso));
}

function deDateTime(iso: string): string {
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" }).format(new Date(iso));
}

function eventLabel(e: PortalLinkCardEvent): string {
  if (e.kind === "VIEW") return "Portal aufgerufen";
  const what = e.fileKind === "UBL" ? "E-Rechnung (XML)" : "PDF";
  return `Download ${what}`;
}

export function PortalLinkCard({ customerId, portalEnabled, customerArchived, link, events, defaultRecipient }: PortalLinkCardProps) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [recipient, setRecipient] = useState(defaultRecipient);
  const rotateRef = useRef<ConfirmDialogHandle>(null);
  const revokeRef = useRef<ConfirmDialogHandle>(null);

  function run(fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) {
    setError(null);
    setInfo(null);
    start(async () => {
      const res = await fn();
      if (!res.ok) setError(res.error ?? "Die Aktion ist fehlgeschlagen.");
      else {
        if (res.message) setInfo(res.message);
        router.refresh();
      }
    });
  }

  function create() {
    setRevealed(null);
    run(async () => {
      const res = await createPortalLinkAction(customerId);
      return res.ok ? { ok: true, message: "Link erzeugt." } : res;
    });
  }

  function revoke() {
    setRevealed(null);
    run(async () => {
      const res = await revokePortalLinkAction(customerId);
      return res.ok ? { ok: true, message: "Link widerrufen." } : res;
    });
  }

  function reveal() {
    setError(null);
    start(async () => {
      const res = await revealPortalUrlAction(customerId);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setRevealed(res.url);
      try {
        await navigator.clipboard.writeText(res.url);
        setInfo("Link in die Zwischenablage kopiert.");
      } catch {
        setInfo("Link angezeigt. Bitte manuell kopieren.");
      }
    });
  }

  function send(e: React.FormEvent) {
    e.preventDefault();
    run(async () => {
      const res = await sendPortalLinkAction(customerId, recipient);
      return res.ok ? { ok: true, message: `Mail an ${res.to} gesendet.` } : res;
    });
  }

  if (!portalEnabled) {
    return (
      <p className="text-sm text-ink-soft">
        Das Kundenportal ist ausgeschaltet. Einschalten unter{" "}
        <Link href="/einstellungen/kundenportal" className="text-pen underline">
          Einstellungen, Kundenportal
        </Link>
        .
      </p>
    );
  }

  const state: "none" | "active" | "revoked" | "expired" = !link ? "none" : link.active ? "active" : link.revokedAt ? "revoked" : "expired";

  return (
    <div className="space-y-4">
      <ErrorBanner message={error ?? undefined} />
      {info && (
        <p role="status" className="text-sm text-ledger">
          {info}
        </p>
      )}

      <div className="text-sm">
        {state === "none" && <p className="text-ink-soft">Kein Link vorhanden.</p>}
        {state === "active" && link && (
          <p className="text-ink-soft">
            <span className="font-medium text-ledger">Aktiv</span> bis {deDate(link.expiresAt)}. Erzeugt am {deDate(link.createdAt)}.{" "}
            {link.viewCount === 0
              ? "Noch nicht aufgerufen."
              : `${link.viewCount} Aufruf${link.viewCount === 1 ? "" : "e"}${link.lastViewedAt ? `, zuletzt ${deDateTime(link.lastViewedAt)}` : ""}.`}
          </p>
        )}
        {state === "revoked" && link?.revokedAt && (
          <p className="text-ink-soft">
            <span className="font-medium text-stamp">Widerrufen</span> am {deDate(link.revokedAt)}. Der Link zeigt nichts mehr an.
          </p>
        )}
        {state === "expired" && link && (
          <p className="text-ink-soft">
            <span className="font-medium text-stamp">Abgelaufen</span> am {deDate(link.expiresAt)}.
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {state === "active" ? (
          <>
            <Button variant="secondary" size="sm" onClick={reveal} disabled={pending}>
              Link kopieren
            </Button>
            <Button variant="secondary" size="sm" onClick={() => rotateRef.current?.open()} disabled={pending}>
              Neu erzeugen
            </Button>
            <Button variant="danger-quiet" size="sm" onClick={() => revokeRef.current?.open()} disabled={pending}>
              Widerrufen
            </Button>
          </>
        ) : (
          !customerArchived && (
            <Button variant="primary" size="sm" onClick={create} disabled={pending}>
              Link erzeugen
            </Button>
          )
        )}
      </div>
      {customerArchived && state !== "active" && <p className="text-xs text-ink-muted">Für archivierte Kunden kann kein Link erzeugt werden.</p>}

      {revealed && (
        <input readOnly className={`${inputCls} w-full font-mono text-xs`} value={revealed} aria-label="Portal-Link" onFocus={(e) => e.currentTarget.select()} />
      )}

      {state === "active" && (
        <form onSubmit={send} className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-64 flex-1 flex-col gap-1 text-sm">
            <span className="font-medium text-ink-soft">Per Mail senden an</span>
            <input className={inputCls} type="email" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="E-Mail-Adresse" />
          </label>
          <Button type="submit" variant="secondary" size="sm" disabled={pending}>
            Per Mail senden
          </Button>
        </form>
      )}

      <div>
        <h3 className="mb-2 text-sm font-semibold text-ink">Letzte Abrufe</h3>
        {events.length === 0 ? (
          <p className="text-sm text-ink-muted">Noch keine Abrufe.</p>
        ) : (
          <ul className="divide-y divide-rule text-sm">
            {events.map((e) => (
              <li key={e.id} className="flex flex-wrap justify-between gap-2 py-1.5">
                <span>
                  {eventLabel(e)}
                  {e.docNumber ? ` · ${e.docNumber}` : ""}
                </span>
                <span className="text-ink-muted">{deDateTime(e.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        ref={rotateRef}
        title="Link neu erzeugen?"
        message="Der alte Link wird ungültig. Der Kunde braucht den neuen Link."
        confirmLabel="Neu erzeugen"
        onConfirm={create}
      />
      <ConfirmDialog
        ref={revokeRef}
        title="Link widerrufen?"
        message="Der Link zeigt danach nichts mehr an. Sie können jederzeit einen neuen Link erzeugen."
        confirmLabel="Widerrufen"
        tone="danger"
        onConfirm={revoke}
      />
    </div>
  );
}
