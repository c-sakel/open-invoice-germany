"use client";

import { useActionState, useState } from "react";
import { saveDocumentSettingsAction } from "@/app/actions/document-settings";
import type { ActionResult } from "@/app/actions/result";
import { SelectField, TextField, CheckboxField, SubmitButton, ErrorBanner } from "./fields";
import { TaxRatesField } from "@/components/settings/TaxRatesField";
import type { DocumentSettingsInput } from "@/schemas";
import { OSS_NOTICE } from "@/schemas/oss";

export interface PaymentMethodOption {
  id: string;
  name: string;
}

export function DocumentSettingsForm({ settings, paymentMethods = [] }: { settings: DocumentSettingsInput; paymentMethods?: PaymentMethodOption[] }) {
  const [state, action] = useActionState<ActionResult, FormData>(saveDocumentSettingsAction, { ok: false });
  const [fxSource, setFxSource] = useState(settings.fxRateSource);
  const [ossMode, setOssMode] = useState(settings.ossCountMode);

  return (
    <form action={action} className="space-y-6">
      <ErrorBanner message={state.error} />
      {state.ok && <p className="text-sm text-ledger">Einstellungen gespeichert.</p>}

      <section className="space-y-4 rounded-[var(--radius-card)] border border-rule bg-sheet p-5">
        <h2 className="font-semibold text-ink">Angebote</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Automatik nach Online-Annahme"
            name="onQuoteAccept"
            defaultValue={settings.onQuoteAccept}
            options={[
              { value: "NONE", label: "Keine — nur Status auf ACCEPTED setzen" },
              { value: "ORDER_CONFIRMATION", label: "Auftragsbestätigung automatisch erzeugen" },
              { value: "INVOICE", label: "Rechnungsentwurf automatisch erzeugen" },
            ]}
          />
          <TextField
            label="Gültigkeitsdauer neuer Links (Tage)"
            name="shareLinkDays"
            defaultValue={String(settings.shareLinkDays)}
            hint="Kann je Link beim Erzeugen überschrieben werden; nie länger als die Angebotsgültigkeit."
          />
          <TextField label="Standard-Gültigkeit neuer Angebote (Tage)" name="quoteValidityDays" defaultValue={String(settings.quoteValidityDays)} />
        </div>
        <CheckboxField
          label="IP-Adresse des Entscheiders speichern"
          name="storeAcceptIp"
          defaultChecked={settings.storeAcceptIp}
          hint="Datenschutzhinweis: Die IP-Adresse wird nur bei aktivierter Option zusammen mit Name/E-Mail/Kommentar der Online-Entscheidung gespeichert und erscheint nie im Audit-Verlauf (ChangeLog)."
        />
        <CheckboxField
          label="Neue Angebote bekommen standardmäßig einen Annahme-Link"
          name="shareLinkDefaultOn"
          defaultChecked={settings.shareLinkDefaultOn}
        />
        <CheckboxField
          label="Beim Anlegen den zuletzt verwendeten Beleg als Vorlage anbieten"
          name="offerLastDocument"
          defaultChecked={settings.offerLastDocument}
          hint="Steuert die Übernehmen-Vorlage bei der Beleganlage (Rechnung/Angebot/Auftragsbestätigung)."
        />
      </section>

      <section className="space-y-4 rounded-[var(--radius-card)] border border-rule bg-sheet p-5">
        <h2 className="font-semibold text-ink">Rechnungen</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Standard-Zahlungsziel (Tage)" name="invoiceDueDays" defaultValue={String(settings.invoiceDueDays)} />
          <TextField label="Standard-Währung" name="defaultCurrency" defaultValue={settings.defaultCurrency} placeholder="EUR" />
          <SelectField
            label="Standard-Zahlungsmethode"
            name="defaultPaymentMethodId"
            defaultValue={settings.defaultPaymentMethodId ?? ""}
            options={[{ value: "", label: "— keine —" }, ...paymentMethods.map((m) => ({ value: m.id, label: m.name }))]}
          />
        </div>
        <SelectField
          label="Kursquelle für Fremdwährungsrechnungen"
          name="fxRateSource"
          defaultValue={settings.fxRateSource}
          onChange={(e) => setFxSource(e.target.value === "ECB_DAILY" ? "ECB_DAILY" : "BMF_MONTHLY")}
          options={[
            { value: "BMF_MONTHLY", label: "Amtlicher Monatsdurchschnitt (§ 16 Abs. 6 UStG)" },
            { value: "ECB_DAILY", label: "EZB-Tageskurs (Gestattung des Finanzamts liegt vor)" },
          ]}
          hint="Der Kurs wird beim Festschreiben eingefroren. Je Beleg ist ein manueller Kurs möglich."
        />
        {fxSource === "ECB_DAILY" && (
          <CheckboxField
            label="Das Finanzamt hat die Umrechnung mit dem EZB-Tageskurs gestattet"
            name="fxEcbConfirmed"
            defaultChecked={settings.fxRateSource === "ECB_DAILY"}
            hint="Ohne Gestattung des Finanzamts ist nach § 16 Abs. 6 UStG der Monatsdurchschnitt zu verwenden. Bitte bestätigen, bevor der EZB-Tageskurs gespeichert wird."
          />
        )}
        <CheckboxField
          label="Rechnung nach dem Versand automatisch festschreiben"
          name="autoFinalizeOnSend"
          defaultChecked={settings.autoFinalizeOnSend}
        />
        <CheckboxField
          label="Lieferdatum automatisch auf Rechnungsdatum setzen"
          name="autoDeliveryDate"
          defaultChecked={settings.autoDeliveryDate}
        />
        <CheckboxField
          label="Rechnungsdatum beim Festschreiben auffrischen, wenn der Entwurf liegen geblieben ist"
          name="refreshIssueDateOnFinalize"
          defaultChecked={settings.refreshIssueDateOnFinalize}
        />
        <CheckboxField label="Zahlungsbedingungs-Text auf dem Beleg anzeigen" name="showPaymentTermsText" defaultChecked={settings.showPaymentTermsText} />
        <CheckboxField label="Neue Rechnungen standardmäßig als E-Rechnung markieren" name="eInvoiceDefault" defaultChecked={settings.eInvoiceDefault} />
      </section>

      <section className="space-y-4 rounded-[var(--radius-card)] border border-rule bg-sheet p-5">
        <h2 className="font-semibold text-ink">Steuersätze</h2>
        <TaxRatesField initial={settings.taxRates} />
      </section>

      <section className="space-y-4 rounded-[var(--radius-card)] border border-rule bg-sheet p-5">
        <h2 className="font-semibold text-ink">Lieferscheine</h2>
        <CheckboxField label="Preise standardmäßig anzeigen" name="dnShowPrices" defaultChecked={settings.dnShowPrices} />
        <CheckboxField label="Artikelnummern standardmäßig anzeigen" name="dnShowArticleNumber" defaultChecked={settings.dnShowArticleNumber} />
        <CheckboxField
          label="Zusätzlichen Lieferadress-Block standardmäßig anzeigen (aus der Standard-Lieferadresse des Kunden; der Empfängerblock wird immer gedruckt)"
          name="dnShowDeliveryAddress"
          defaultChecked={settings.dnShowDeliveryAddress}
        />
      </section>

      <section className="space-y-4 rounded-[var(--radius-card)] border border-rule bg-sheet p-5">
        <h2 className="font-semibold text-ink">Wiederkehrende Rechnungen</h2>
        <CheckboxField
          label="Abrechnungszeitraum-Kopftext automatisch einfügen"
          name="recurringInsertPeriodText"
          defaultChecked={settings.recurringInsertPeriodText}
        />
        <CheckboxField
          label="Neue Abos standardmäßig automatisch festschreiben"
          name="recurringAutoFinalizeDefault"
          defaultChecked={settings.recurringAutoFinalizeDefault}
        />
        <CheckboxField label="Neue Abos standardmäßig automatisch versenden" name="recurringAutoSendDefault" defaultChecked={settings.recurringAutoSendDefault} />
      </section>

      <section className="space-y-4 rounded-[var(--radius-card)] border border-rule bg-sheet p-5">
        <h2 className="font-semibold text-ink">EU-Fernverkäufe (OSS-Schwelle)</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Zählweise"
            name="ossCountMode"
            defaultValue={settings.ossCountMode}
            onChange={(e) => setOssMode(e.target.value === "BY_PRODUCT" ? "BY_PRODUCT" : "ALL_EU_B2C")}
            options={[
              { value: "ALL_EU_B2C", label: "Alle EU-Privatkunden-Umsätze zählen (vorsichtig, Standard)" },
              { value: "BY_PRODUCT", label: "Nur Positionen mit OSS-Kategorie" },
            ]}
          />
          <TextField label="Warnung ab (%)" name="ossWarnPercent" type="number" defaultValue={String(settings.ossWarnPercent)} hint="Ganze Zahl von 1 bis 99." />
        </div>
        {ossMode === "BY_PRODUCT" && (
          <p className="text-sm text-ink-soft">
            Gezählt werden nur Positionen, deren Produkt oder Position eine OSS-Kategorie trägt. Neue Produkte haben „Keine“ — Kategorien in den Produkten pflegen. Rechnungen per API ohne Produkt brauchen das Feld ossCategory je Position. Anteils-Teilrechnungen zählen hier nie, Abschläge erst mit der Schlussrechnung, Belege von vor Phase 16e gar nicht — für das Einführungsjahr und das Vorjahr gilt die Standard-Zählweise.
          </p>
        )}
        <p className="text-xs text-ink-muted">{OSS_NOTICE}</p>
      </section>

      <SubmitButton>Einstellungen speichern</SubmitButton>
    </form>
  );
}
