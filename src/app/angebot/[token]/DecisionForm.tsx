"use client";

import { useActionState } from "react";
import { decideOfferAction } from "./actions";
import type { ActionResult } from "@/app/actions/result";

const initialState: ActionResult = { ok: false };

export function DecisionForm({ token }: { token: string }) {
  const boundAction = decideOfferAction.bind(null, token);
  const [state, action, pending] = useActionState<ActionResult, FormData>(boundAction, initialState);

  return (
    <form action={action} className="space-y-4 rounded-[var(--radius-card)] border border-rule bg-sheet p-5">
      <h2 className="font-semibold text-ink">Ihre Entscheidung</h2>

      {state.error && <div className="rounded-md border border-stamp/30 bg-stamp/10 p-3 text-sm text-stamp">{state.error}</div>}

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-ink-soft">
          Name <span className="text-stamp">*</span>
        </span>
        <input name="name" required className="rounded-md border border-rule-strong px-3 py-2 text-sm" />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-ink-soft">E-Mail</span>
        <input name="email" type="email" className="rounded-md border border-rule-strong px-3 py-2 text-sm" />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-ink-soft">Kommentar</span>
        <textarea name="comment" rows={3} className="rounded-md border border-rule-strong px-3 py-2 text-sm" />
      </label>

      <div className="flex flex-wrap gap-3 pt-2">
        <button
          type="submit"
          name="decision"
          value="ACCEPTED"
          disabled={pending}
          className="rounded-md bg-ledger px-4 py-2 text-sm font-medium text-white hover:bg-ledger disabled:opacity-60"
        >
          {pending ? "Wird gespeichert…" : "Angebot annehmen"}
        </button>
        <button
          type="submit"
          name="decision"
          value="REJECTED"
          disabled={pending}
          className="rounded-md border border-stamp/30 bg-sheet px-4 py-2 text-sm font-medium text-stamp hover:bg-stamp/10 disabled:opacity-60"
        >
          {pending ? "Wird gespeichert…" : "Angebot ablehnen"}
        </button>
      </div>
    </form>
  );
}
