"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveBankFetchSettingsAction } from "@/app/einstellungen/kontoabruf/actions";
import { inputCls, ErrorBanner } from "@/components/forms/fields";
import { Button } from "@/components/ui/Button";
import { FINTS_ORG_URL, PRODUCT_ID_NOTICE, PRODUCT_ID_STORED_NOTICE, SECRET_FIELD_HINT } from "./bank-fetch-ui";

/** Produkt-ID der Installation. Das Feld ist nie vorbefüllt; die ID wird nie angezeigt, nur "hinterlegt". */
export function ProductIdForm({ configured }: { configured: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  function save(productId: string | null) {
    setError(null);
    setInfo(null);
    start(async () => {
      const r = await saveBankFetchSettingsAction({ productId });
      if (!r.ok) setError(r.error);
      else {
        setValue("");
        setInfo(productId === null ? "Produkt-ID entfernt." : "Produkt-ID gespeichert.");
      }
      router.refresh();
    });
  }

  return (
    <section aria-label="Produkt-ID" className="space-y-3 rounded-[var(--radius-card)] border border-rule bg-sheet p-5 text-sm">
      <h2 className="font-semibold text-ink">Produkt-ID</h2>
      <p role="note" className="max-w-3xl rounded-md border border-rule bg-paper p-3 text-ink-soft">
        {PRODUCT_ID_NOTICE}{" "}
        <a href={FINTS_ORG_URL} target="_blank" rel="noopener noreferrer" className="text-pen underline">
          fints.org
        </a>
      </p>
      <ErrorBanner message={error ?? undefined} />
      {info ? <p className="text-ledger">{info}</p> : null}
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim() !== "") save(value.trim());
        }}
      >
        <label className="flex min-w-0 flex-col gap-1">
          <span className="font-medium text-ink-soft">Produkt-ID</span>
          <input
            className={`${inputCls} w-full min-w-0 sm:w-80`}
            type="password"
            name="productId"
            value={value}
            maxLength={30}
            autoComplete="off"
            spellCheck={false}
            placeholder={configured ? "hinterlegt" : ""}
            onChange={(e) => setValue(e.target.value)}
          />
          <span className="text-xs text-ink-muted">{configured ? PRODUCT_ID_STORED_NOTICE : SECRET_FIELD_HINT}</span>
        </label>
        <Button type="submit" variant="primary" disabled={pending || value.trim() === ""}>
          {pending ? "Bitte warten …" : "Speichern"}
        </Button>
        {configured ? (
          <Button variant="secondary" disabled={pending} onClick={() => save(null)}>
            Entfernen
          </Button>
        ) : null}
      </form>
    </section>
  );
}
