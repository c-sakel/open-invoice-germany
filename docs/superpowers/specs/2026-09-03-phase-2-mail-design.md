# Phase 2 — Textvorlagen, Platzhalter, E-Mail-Versand, E-Mail-Historie

**Lastenheft:** §17 Textvorlagen, §18 Platzhaltersystem, §19 Standard-E-Mail-Texte, §20 Versandfenster, §21 Versandkonfiguration, §22 E-Mail-Historie (`docs/superpowers/requirements/2026-09-02-lastenheft-auftragsverwaltung.md`). Nutzerwünsche ergänzend: Mailserver-Daten in den Einstellungen pflegen und testen; CC/BCC mit Vorbelegung; Versand für Angebot, Auftragsbestätigung, Lieferschein, Rechnung, Storno/Gutschrift, Mahnung.

**Baut auf Phase 1 auf:** `TextTemplate`, `EmailTemplate`, `EmailLog` (Text vollständig, Anhänge als SHA-256), `DunningStage.emailTemplateId`, `ContactPerson`, `PaymentMethod`.

## 1. Ist-Stand (Audit-Auszug)

- Kein Mailversand, keine Mail-Abhängigkeit im Repo. Upstream-ARCHITEKTUR nennt Resend als Option; der Betreiber will SMTP (Mailcow, self-hosted).
- Eine Einstellungsseite `src/app/einstellungen/page.tsx` → `OrganizationForm` → `saveOrganization` (`src/app/actions/masterdata.ts`).
- PDF/XML: `loadEInvoiceData(invoiceId)` → `renderInvoicePdf` / `renderZugferdPdf` / `buildXRechnungUBL`; Angebot/AB über `buildDocEInvoiceData` (`src/domain/document/pdf-data.ts`, Route `api/documents/[id]/pdf`); Mahnung `renderDunningPdf`.
- Auth: `src/proxy.ts` schützt alles außer `/login`, `/setup`, `/api/auth`, `/api/cron`. Server Actions laufen hinter dem Login.
- `AUTH_SECRET` signiert Sessions; kein Verschlüsselungsmechanismus vorhanden.
- `EmailTemplate` hat keinen Unique-Constraint (nur Index `orgId, docType`).
- `Customer.email`, `Customer.leitwegId` vorhanden; keine Präferenz für E-Rechnungsformat.

## 2. Entscheidungen

| Frage | Entscheidung | Warum |
|---|---|---|
| Provider | **SMTP via `nodemailer`**, hinter Interface `MailProvider { send(msg): Promise<{providerId?}> }`. Resend/SES nicht gebaut, Interface hält die Tür offen. | §21 self-hosted, kein Lock-in; Betreiber nutzt Mailcow. |
| Ablage SMTP-Daten | Neues Modell **`MailSettings`** 1:1 zu `Organization` (Host, Port, `security` STARTTLS/TLS/NONE, User, `passwordEnc`, `fromName`, `fromEmail`, `replyTo?`, `defaultCc`, `defaultBcc`, `copyToSelf`). Keine Env-Variablen. | §21: im UI pflegbar; eine Quelle. |
| Passwort | **AES-256-GCM**, Schlüssel per HKDF aus `AUTH_SECRET` (Info `oig-mail-settings-v1`). Format `v1:<iv>:<tag>:<ct>` base64. Ohne `AUTH_SECRET` wird das Speichern mit klarer Fehlermeldung abgelehnt. UI zeigt nie das Passwort; leeres Feld = unverändert. | §21 „Secrets nicht unverschlüsselt ausgeben“; kein zweites Secret nötig. |
| Standardtexte | `DEFAULT_EMAIL_TEMPLATES` in `src/domain/masterdata/defaults.ts`, angelegt durch `ensureOrgMasterdata` (idempotent über neuen Unique `orgId, docType, name`). **Kein SQL-Backfill** — Selbstheilung greift bei Org-Speichern, Seed, Setup und beim ersten Versand. | Lange Texte gehören nicht in SQL-Migrationen; Phase-1-Muster. |
| Mahnstufen-Texte | Je `DunningStage` eine Standardvorlage (`docType=DUNNING`, Name „Mahnung Stufe n“), verknüpft über `DunningStage.emailTemplateId`. | §19 „je Mahnstufe separate Standardvorlage“. |
| Platzhalter-Syntax | `{{pfad.zu.wert}}`; Engine in `src/lib/template/`. Fehlende Pfade → leerer String + Warnungsliste (nie Exception). Formatierung: Geld `1.234,56 €`, Datum `dd.MM.yyyy`. | §18. |
| Kontext-Quelle | Festgeschriebene Belege liefern Kunden-/Firmenwerte aus dem **Phase-0-Snapshot**; Entwürfe aus dem Stamm. | GoBD-konsistent mit PDF. |
| Anhänge Rechnung | Festgeschrieben: **ZUGFeRD-PDF** (PDF/A-3 mit eingebettetem XML) statt Plain-PDF; zusätzlich XRechnung-XML, wenn `Customer.leitwegId` gesetzt. Entwurf: Plain-PDF mit Wasserzeichen-Hinweis im Dateinamen `…-ENTWURF.pdf`. | §20 „bei E-Rechnung entsprechend sinnvoll“; ZUGFeRD ist ein gültiges PDF. |
| Anhänge Storno/Gutschrift | Wie Rechnung (sind `Invoice`-Datensätze). | — |
| Anhänge Angebot/AB/Lieferschein | PDF über `buildDocEInvoiceData` bzw. Lieferschein-PDF (Phase 3 bringt das PDF; bis dahin Lieferschein ohne Versand-Button). | Reihenfolge Lastenheft. |
| Anhänge Mahnung | Mahnungs-PDF + Rechnungs-PDF der gemahnten Rechnung. | Praxisstandard. |
| Zusatzanhänge | Upload im Modal, je Datei ≤ 10 MB, gesamt ≤ 20 MB, erlaubte Typen PDF/PNG/JPG/XML/CSV/TXT. Im Log nur Name/Größe/SHA-256. | Phase-1-Ruling „Anhänge als Hash“. |
| Status | SMTP kennt `queued` → `sent` / `failed`. `delivered`/`bounced` sind reserviert und werden ohne Provider-Webhook nicht gesetzt (dokumentiert). | Ehrlich statt Attrappe. |
| Erneut senden | Neuer `EmailLog` mit `resendOfId`; Modal vorbelegt aus dem alten Log. | §22. |
| Audit | `ChangeLog` Eintrag `entityType=EMAIL`, `action=SENT|FAILED`, Payload = Log-ID, Empfänger, Betreff, Anhang-Hashes. | §22 „Auditlog erweitern“. |
| „Kopie an mich“ | Fügt `fromEmail` als BCC hinzu; Default aus `MailSettings.copyToSelf`. | §20. |
| Testmail | Button in den Mail-Einstellungen sendet an `Organization.email` (Fallback `fromEmail`), loggt nicht in `EmailLog`. | Nutzerwunsch „testen“. |

## 3. Datenmodell (beide Dialekte, Migration `phase2_mail`)

```prisma
model MailSettings {
  id            String   @id @default(cuid())
  orgId         String   @unique
  org           Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  host          String
  port          Int
  security      String   // "STARTTLS" | "TLS" | "NONE"
  username      String?
  passwordEnc   String?  // AES-256-GCM, siehe src/lib/crypto/secrets.ts
  fromName      String
  fromEmail     String
  replyTo       String?
  defaultCc     String   @default("")   // kommagetrennt
  defaultBcc    String   @default("")
  copyToSelf    Boolean  @default(false)
  lastTestAt    DateTime?
  lastTestOk    Boolean?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
}
```

Änderungen an Bestandsmodellen:
- `EmailTemplate`: `@@unique([orgId, docType, name])`; Feld `isSystem Boolean @default(false)` (Standardvorlage erkennbar, bleibt editierbar).
- `EmailLog`: `resendOfId String?`, `fromEmail String`, `replyTo String?`, `warningsJson String @default("[]")` (fehlende Platzhalter), `sentByUserId String?`.
- `DunningStage.emailTemplateId` existiert (Phase 1) — wird jetzt befüllt.

## 4. Module

```
src/lib/crypto/secrets.ts          encryptSecret / decryptSecret (HKDF + AES-GCM), Fehler ohne AUTH_SECRET
src/lib/template/render.ts         renderTemplate(text, ctx) → { text, warnings[] }
src/lib/template/format.ts         formatMoney(cents), formatDate(d)
src/lib/mail/provider.ts           interface MailProvider, type OutgoingMail
src/lib/mail/smtp.ts               SmtpProvider(nodemailer), aus MailSettings gebaut
src/lib/mail/fake.ts               InMemoryProvider für Tests
src/domain/email/context.ts        buildTemplateContext(docType, docId) — Snapshot-bewusst
src/domain/email/attachments.ts    buildStandardAttachments(docType, docId) → {filename, mime, buffer}[]
src/domain/email/compose.ts        composeEmail(input) → Vorschau (Betreff/Body/Signatur gerendert, Anhänge, Warnungen)
src/domain/email/send.ts           sendDocumentEmail(orgId, userId, input) — Log queued → send → sent/failed, ChangeLog
src/domain/email/settings.ts       loadMailSettings(orgId) (entschlüsselt), saveMailSettings(orgId, input), sendTestMail
src/domain/masterdata/defaults.ts  + DEFAULT_EMAIL_TEMPLATES
src/domain/masterdata/ensure.ts    + Vorlagen-Upsert + Verknüpfung DunningStage.emailTemplateId
src/schemas/email.ts               Zod: MailSettingsInput, SendEmailInput, EmailTemplateInput, Address-Listen
src/app/actions/email.ts           Server Actions: saveMailSettingsAction, sendTestMailAction, previewEmailAction, sendEmailAction, resendEmailAction
src/app/actions/templates.ts       CRUD EmailTemplate/TextTemplate, setDefault
src/app/einstellungen/email/page.tsx      SMTP-Formular + Testmail
src/app/einstellungen/vorlagen/page.tsx   Liste + Editor + Vorschau (Beispielkontext)
src/app/emails/[id]/page.tsx              Inhalt einer gesendeten Mail
src/components/SendEmailDialog.tsx        Modal (Client), Felder nach §20
src/components/EmailHistory.tsx           Verlauf je Beleg (Server)
```

Einbau des Versand-Buttons: `rechnungen/[id]` (Rechnung, Storno, Gutschrift), `dokumente/[id]` (Angebot, AB), Mahnungsliste in `rechnungen/[id]`. Lieferschein folgt in Phase 3.

## 5. Platzhalter-Kontext

```
customer.name | firstName | lastName | number | email
document.type | number | date | dueDate | total | netTotal | taxTotal
invoice.number | total | dueDate | openAmount      (bei INVOICE/DUNNING)
offer.number | validUntil                          (bei ANGEBOT)
company.name | email | phone | iban | bic
contact.name                                       (Hauptansprechpartner, sonst leer)
payment.iban | bic
customer.customField.<key>                         (leer bis Custom Fields existieren; Pfad reserviert)
```
`document.type` liefert die deutsche Bezeichnung („Rechnung“, „Angebot“ …). Unbekannte Pfade → Warnung `Unbekannter Platzhalter {{x}}`.

## 6. Versandablauf

1. Modal öffnet → `previewEmailAction` liefert vorbelegte Felder: Von (readonly), An (`Customer.email`, sonst leer + Hinweis), CC/BCC (Defaults), Betreff/Nachricht/Signatur (Standardvorlage des Dokumenttyps, bei Mahnung die Stufenvorlage), Standardanhänge (Checkbox, vorausgewählt), Warnungen.
2. Nutzer editiert, lädt ggf. Dateien hoch, klickt „Vorschau“ (gerenderter Text) oder „Senden“.
3. `sendEmailAction` → Zod → `sendDocumentEmail`:
   - `EmailLog` mit `status=queued` anlegen (Text vollständig, Anhänge als Hash).
   - Provider senden; Erfolg → `sent`, `providerId`, `sentAt`; Fehler → `failed`, `error` (Klartext der SMTP-Antwort, ohne Zugangsdaten).
   - `ChangeLog` schreiben (`EMAIL`/`SENT` bzw. `FAILED`). Hash-Chain seriell wie bisher.
4. Detailseite zeigt Verlauf; Fehlversand ist rot mit Fehlertext und „Erneut senden“.

Kein Hintergrund-Queue: Versand synchron in der Action (SMTP-Timeout 20 s). Ein Scheduler kommt in Phase 6.

## 7. Sicherheit

- Alle Actions prüfen Session und Org-Zugehörigkeit des Belegs.
- Adressen per Zod (`z.string().email()`), Listen kommagetrennt, max. 20 Empfänger je Feld.
- Kein HTML-Mail in Phase 2: Text/plain; Signatur als Textblock. HTML-Rendering ist Backlog.
- `passwordEnc` verlässt nie den Server; Actions liefern `hasPassword: boolean`.
- Fehlertexte an das UI werden auf 500 Zeichen gekürzt und von Passwörtern bereinigt.

## 8. Tests

- Unit: `render.test.ts` (Pfade, fehlende Werte, Formatierung, Warnungen), `secrets.test.ts` (Roundtrip, falscher Key, fehlendes AUTH_SECRET), `attachments.test.ts` (Dateinamen, ZUGFeRD vs. Entwurf, XRechnung nur mit Leitweg-ID), `defaults.test.ts` (Vorlagen je Dokumenttyp vorhanden, Mahnstufen verknüpft).
- Integration (`test/integration/email.test.ts`, SQLite, InMemoryProvider): Versand Rechnung → Log `sent`, ChangeLog-Eintrag, Hash-Kette intakt; Provider-Fehler → Log `failed` mit Fehler; erneut senden → neues Log mit `resendOfId`; Selbstheilung legt Vorlagen an.
- Postgres-Skript: Fall 1 Tabellenzahl 26; Fall 3/4 unverändert.

## 9. Doku

`docs/LIMITATIONEN.md` (Mail: nur SMTP, kein Bounce-Tracking, Text/plain), `docs/ARCHITEKTUR.md` (Mail-Pfad, Secrets), `.env.example` (Hinweis: AUTH_SECRET ist jetzt auch Schlüssel für Mail-Passwort — Wechsel invalidiert gespeicherte SMTP-Passwörter), `BETRIEB.md` auf dem Server (Mailcow-Werte eintragen).

## 10. Nicht in Phase 2

Lieferschein-PDF (Phase 3), HTML-Mails, Resend/SES-Provider, Bounce-Webhooks, Hintergrund-Queue, Custom Fields (§31), MCP-Tool `send_email` (§55, eigene Phase), Mahn-Automatik (Phase 4).
