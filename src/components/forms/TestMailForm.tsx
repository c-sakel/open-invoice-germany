"use client";

import { useActionState } from "react";
import { sendTestMailAction } from "@/app/actions/email";
import type { ActionResult } from "@/app/actions/result";
import { SubmitButton, ErrorBanner } from "./fields";

export function TestMailForm() {
  const [state, action] = useActionState<ActionResult, FormData>(sendTestMailAction, { ok: false });

  return (
    <form action={action} className="space-y-2 rounded-[var(--radius-card)] border border-rule bg-sheet p-5">
      <h2 className="font-semibold text-ink">Testmail</h2>
      <p className="text-sm text-ink-soft">Sendet eine Testnachricht mit den aktuell gespeicherten Einstellungen.</p>
      <ErrorBanner message={state.error} />
      {state.ok && <p className="text-sm text-ledger">Testmail erfolgreich gesendet.</p>}
      <SubmitButton>Testmail senden</SubmitButton>
    </form>
  );
}
