# Phase 3b — Online-Angebotsannahme: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein Angebot bekommt optional einen sicheren öffentlichen Link, über den der Kunde es ansehen, als PDF laden, annehmen oder ablehnen kann — mit Token-Hash statt Klartext, Ablauf, Widerruf, Rate-Limit, Audit-Eintrag, Benachrichtigung an den Betreiber und optionaler Automatik (AB oder Rechnung erzeugen).

**Architecture:** Neues Modell `QuoteShareLink` (nur SHA-256 des Tokens), Domain `src/domain/quote-share/*` (Link erzeugen/widerrufen/auflösen, Annahme/Ablehnung transaktional über die Phase-3a-Zustandsmaschine und `convertDocument`), öffentliche Route `/angebot/[token]` (Server-Komponente + Server Actions, in `PUBLIC_PREFIXES`), In-Memory-Rate-Limit, Einstellungen `DocumentSettings` je Organisation.

**Tech Stack:** Next.js 16, TypeScript strict, Prisma 6.19.3 (SQLite + Postgres), Zod 4, vitest, node:crypto.

**Spec:** `docs/superpowers/specs/2026-09-03-phase-3-dokumente-design.md`, Abschnitt „Online-Annahme (3b)" und „Automatik nach Annahme" (Branch `specs`).

## Global Constraints

- Keine Prisma-Enums, kein Json; Zod an jeder Boundary **und** in jeder Domain-Funktion; beide Schemas byte-gleich bis auf Provider; Migrationen in beiden Dialekten, additiv.
- GoBD: jede Statusänderung/Erzeugung mit `appendChangeLog` in derselben Transaktion; Konvertierungen über `convertDocument` (Phase 3a, transaktional).
- Sicherheit: Token 32 Byte Zufall, base64url; in der DB nur `sha256(token)`; konstante Vergleichszeit über Hash-Lookup; keine Aufzählung (404 für unbekannt/abgelaufen/widerrufen, gleiche Antwortzeit-Klasse); Rate-Limit je IP und je Token; keine internen Notizen, keine Preise über das Nötige hinaus (das PDF ist das, was der Kunde ohnehin bekommt); IP nur mit Einstellung; öffentliche Seite ohne Navigation/Login-Leaks.
- Prüfkette vor jedem Task-Abschluss: `npm run typecheck && npm run lint && npm test && npm run build && npm run validate:erechnung`. Tests: Jahr **2032**.
- Deutsche UI-Texte/Kommentare; Commit-Messages ohne Umlaute; `git commit -s` mit Trailern.

---

## Dateistruktur

| Datei | Verantwortung |
|---|---|
| Prisma (beide) + Migration `phase3b_share_links` | `QuoteShareLink`, `DocumentSettings`, `Organization.documentSettings`, `Quote.shareLinks` |
| `src/schemas/index.ts` | `documentSettingsSchema`, `shareLinkCreateSchema`, `offerDecisionSchema` (name, email?, comment?, decision) |
| `src/lib/rate-limit.ts` | `rateLimit(key, { limit, windowMs })` In-Memory-Token-Bucket, `RateLimitError` |
| `src/domain/quote-share/token.ts` | `generateToken()`, `hashToken(token)` |
| `src/domain/quote-share/link.ts` | `createShareLink(orgId, quoteId, actor, opts)`, `revokeShareLink(orgId, linkId, actor)`, `resolveShareToken(token)` → `{ link, quote } \| null`, `listShareLinks(orgId, quoteId)` |
| `src/domain/quote-share/decide.ts` | `decideOffer(token, input, ctx)` → Annahme/Ablehnung transaktional, Automatik, Benachrichtigung |
| `src/domain/quote-share/settings.ts` | `loadDocumentSettings(orgId)` (mit Defaults), `saveDocumentSettings(orgId, input)` |
| `src/domain/email/notify.ts` | `sendInternalNotification(orgId, { subject, text, docType, docId })` — Mail an `org.email` über den Provider, EmailLog sichtbar in der Historie |
| `src/proxy.ts` | `PUBLIC_PREFIXES` + `/angebot/` (Seite) und `/api/public/` (PDF) |
| `src/app/angebot/[token]/page.tsx`, `actions.ts`, `src/app/api/public/angebot/[token]/pdf/route.ts` | öffentliche Ansicht, Entscheidung, PDF |
| `src/app/api/documents/[id]/share-links/route.ts` (POST/GET), `[linkId]/route.ts` (DELETE = widerrufen) | Betreiber-Seite |
| `src/app/actions/document-settings.ts`, `src/app/einstellungen/dokumente/page.tsx`, `src/components/forms/DocumentSettingsForm.tsx` | Einstellungen |
| `src/components/ShareLinkPanel.tsx` | auf `dokumente/[id]`: Link erzeugen (Token wird EINMAL angezeigt), Liste, Widerruf, Status |
| Tests | `test/unit/rate-limit.test.ts`, `test/unit/share-token.test.ts`, `test/integration/quote-share.test.ts` |
| Doku | LIMITATIONEN (Rate-Limit single-instance, Token einmalig sichtbar), ARCHITEKTUR, README, Postgres-Skript (Tabellenzahl 28) |

---

### Task 1: Schema, Migration, Zod, Token, Rate-Limit

```prisma
model QuoteShareLink {
  id              String    @id @default(cuid())
  orgId           String
  quoteId         String
  quote           Quote     @relation(fields: [quoteId], references: [id], onDelete: Cascade)
  tokenHash       String    @unique
  expiresAt       DateTime
  revokedAt       DateTime?
  createdBy       String
  createdAt       DateTime  @default(now())
  viewCount       Int       @default(0)
  lastViewedAt    DateTime?
  decidedAt       DateTime?
  decision        String?   // "ACCEPTED" | "REJECTED"
  deciderName     String?
  deciderEmail    String?
  deciderComment  String?
  deciderIp       String?
  @@index([orgId, quoteId])
}
model DocumentSettings {
  id             String       @id @default(cuid())
  orgId          String       @unique
  org            Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  onQuoteAccept  String       @default("NONE")   // NONE | ORDER_CONFIRMATION | INVOICE
  shareLinkDays  Int          @default(30)
  storeAcceptIp  Boolean      @default(false)
  updatedAt      DateTime     @updatedAt
}
```

```ts
export const OnQuoteAccept = z.enum(["NONE", "ORDER_CONFIRMATION", "INVOICE"]);
export const documentSettingsSchema = z.object({ onQuoteAccept: OnQuoteAccept.default("NONE"), shareLinkDays: z.coerce.number().int().min(1).max(365).default(30), storeAcceptIp: z.boolean().default(false) });
export const shareLinkCreateSchema = z.object({ expiresInDays: z.coerce.number().int().min(1).max(365).optional() });
export const offerDecisionSchema = z.object({ decision: z.enum(["ACCEPTED", "REJECTED"]), name: z.string().trim().min(2).max(120), email: z.string().trim().pipe(z.email()).optional().or(z.literal("")), comment: z.string().trim().max(2000).optional() });
```

`token.ts`: `generateToken()` = `randomBytes(32).toString("base64url")`; `hashToken(t)` = sha256 hex. `rate-limit.ts`: Map<string, { tokens, updatedAt }>, `limit` 10 / `windowMs` 60_000, Aufräumen alter Einträge bei jedem 100. Aufruf; Test: 10 ok, 11. wirft, nach Fenster wieder ok (Zeit injizierbar).

- [ ] Schema + Migrationen (beide Dialekte, additiv), Zod, token.ts, rate-limit.ts, Tests; Commit `feat(share): Schema, Token und Rate-Limit fuer Angebotslinks`.

### Task 2: Domain — Links, Auflösung, Entscheidung, Einstellungen, Benachrichtigung

- `createShareLink`: nur für `kind === "ANGEBOT"` mit Status DRAFT/SENT/EXPIRED (Ruling: DRAFT erlaubt, Link-Erzeugung setzt das Angebot NICHT auf SENT — das macht der Mailversand oder die manuelle Aktion); `expiresAt` = `min(validUntil ?? ∞, now + (expiresInDays ?? settings.shareLinkDays))`; gibt `{ link, token }` zurück — der Klartext-Token existiert nur in dieser Antwort; ChangeLog `QUOTE`/`SHARE_LINK_CREATED` (nur linkId, expiresAt).
- `revokeShareLink`: `revokedAt = now`, ChangeLog `SHARE_LINK_REVOKED`.
- `resolveShareToken(token)`: Hash-Lookup; null wenn unbekannt, widerrufen, abgelaufen, Angebot archiviert/storniert; sonst `{ link, quote (mit lines, org, customer) }`; zählt `viewCount`/`lastViewedAt` (kein ChangeLog — Lesezugriff).
- `decideOffer(token, rawInput, ctx: { ip?: string; now?: Date })`: Zod; Rate-Limit-Prüfung (`ip` und `tokenHash`); Auflösung; wenn `link.decidedAt` → Fehler „bereits entschieden"; Transaktion: `setQuoteStatusWithinTx(tx, orgId, quoteId, decision, { actor: "public:" + name, note: comment })`, Link-Felder (`decidedAt`, `decision`, `deciderName`, `deciderEmail`, `deciderComment`, `deciderIp` nur bei `settings.storeAcceptIp`), ChangeLog `QUOTE`/`ACCEPTED_ONLINE` bzw. `REJECTED_ONLINE` mit `{ name, email, comment, linkId }` (IP nie im ChangeLog); bei ACCEPTED und `onQuoteAccept !== "NONE"`: `convertDocument(orgId, { fromType: "QUOTE", fromId, toKind }, { actor })` — **in derselben Transaktion**? `convertDocument` öffnet eine eigene → daher nach der Entscheidungs-Tx aufrufen und Fehler als `automationError` zurückgeben (Angebot bleibt ACCEPTED, Betreiber sieht den Fehler in der Benachrichtigung). Danach `sendInternalNotification` (Fehler nur `console.warn`).
- `sendInternalNotification`: `loadMailSettings` → wenn keine, `console.warn` und return; Provider senden an `org.email ?? settings.fromEmail`; EmailLog (docType ANGEBOT, docId quoteId, to = org.email, bodySnapshot = Text, status SENT/FAILED) + ChangeLog `EMAIL`/`SENT|FAILED` wie `sendDocumentEmail`. Wiederverwendung: aus `send.ts` die Log/ChangeLog-Schreiblogik in eine interne Hilfsfunktion ziehen (kein Duplikat).
- Tests (`quote-share.test.ts`, In-Memory-Provider, Jahr 2032): Link nur für Angebote; Token nicht in DB (nur Hash, `findFirst({ tokenHash: hash })` trifft, Klartext-Suche nicht); abgelaufen/widerrufen → null; Annahme → ACCEPTED + ChangeLog + Link-Felder + Benachrichtigungs-EmailLog; zweite Entscheidung → Fehler; Ablehnung → REJECTED; Rate-Limit 11. Aufruf → `RateLimitError`; Automatik ORDER_CONFIRMATION erzeugt AB mit Relation, INVOICE erzeugt Rechnungsentwurf; IP nur mit Einstellung gespeichert; `verifyChain` gültig.
- [ ] Commit `feat(share): Angebotslinks, Online-Entscheidung, Automatik und Benachrichtigung`.

### Task 3: Öffentliche Seite, Routen, Einstellungen, UI, Doku

- `src/proxy.ts`: `PUBLIC_PREFIXES` + `"/angebot/"`, `"/api/public/"`. Test in `test/unit/proxy-public.test.ts` (falls die Prefix-Liste exportierbar ist — sonst extrahieren).
- `/angebot/[token]/page.tsx` (Server): `resolveShareToken` → 404 `notFound()`; zeigt Absender (Seller-Snapshot), Angebotsnummer/-datum/gültig bis, Positionen mit Netto/Brutto (aus dem Beleg, wie das PDF), Kopf-/Fußtext gerendert, Button „PDF herunterladen" (`/api/public/angebot/<token>/pdf`), Formular Annehmen/Ablehnen (Name Pflicht, E-Mail optional, Kommentar), nach Entscheidung eine Bestätigungsansicht („Vielen Dank, Ihr Angebot wurde am … angenommen"). Server Action `decideOfferAction` nutzt `headers()` für IP (`x-forwarded-for` erster Eintrag; hinter Cloudflare `cf-connecting-ip` bevorzugen) und ruft `decideOffer`. Keine Navigation/Layout-Links des internen Bereichs: eigenes `layout.tsx` unter `angebot/`.
- PDF-Route öffentlich: Rate-Limit je Token (30/min), `resolveShareToken`, `buildDocEInvoiceData` + `renderInvoicePdf`; `Content-Disposition: attachment`.
- Betreiber-Routen `share-links` (POST erzeugt und liefert den Token EINMAL; GET Liste ohne Token; DELETE widerruft). `ShareLinkPanel` auf `dokumente/[id]` (nur ANGEBOT): Button „Link erzeugen" → Dialog zeigt URL einmalig mit „Kopieren"; Liste (erstellt, läuft ab, Aufrufe, Entscheidung, Widerruf-Button). Basis-URL aus `headers().get("host")` + Protokoll bzw. `APP_BASE_URL` env (neu in `.env.example`, optional).
- Einstellungen → Dokumente (`SettingsTabs`): `onQuoteAccept` Select, `shareLinkDays`, `storeAcceptIp` Checkbox mit Datenschutzhinweis.
- Mail-Vorlage ANGEBOT: Platzhalter `{{offer.link}}` — im Kontext von `buildTemplateContext` für ANGEBOT den aktivsten gültigen Link (falls vorhanden) als URL liefern, sonst leer; Standardtext um einen Satz „Sie können das Angebot auch online ansehen und annehmen: {{offer.link}}" ergänzen (nur in `DEFAULT_EMAIL_TEMPLATES`, bestehende Orgs unverändert — Ruling).
- Doku: LIMITATIONEN (Rate-Limit nur pro Instanz, Token nur einmal sichtbar, keine Mehrsprachigkeit), ARCHITEKTUR (öffentlicher Pfad, Token-Hashing, Rate-Limit), README (Angebot online annehmen lassen), Postgres-Skript Tabellenzahl **28**.
- Manuelle Prüfung: Link erzeugen → im Inkognito-Fenster öffnen → PDF → annehmen → Angebot ACCEPTED, Benachrichtigung im Verlauf, AB erzeugt (Einstellung ORDER_CONFIRMATION) → zweiter Aufruf zeigt „bereits entschieden" → Widerruf → 404.
- [ ] Drei Commits: Routen/Actions (`feat(share): oeffentliche Angebotsseite, PDF und Betreiber-Routen`), UI/Einstellungen (`feat(share): Link-Verwaltung und Dokument-Einstellungen im UI`), Doku (`docs(share): Online-Angebotsannahme dokumentiert`).

## Self-Review

- §4 vollständig: ansehen/PDF/annehmen/ablehnen; Name/E-Mail/Kommentar/Timestamp; IP nur konfiguriert; Token kryptografisch sicher, Ablauf, Widerruf, Rate-Limiting; Status ACCEPTED; Audit; Benutzer informieren; Automatik AB/Rechnung. Platzhalter `{{offer.link}}` deckt „Angebote sollen optional einen Link enthalten".
- Sicherheits-Selbstcheck: Klartext-Token nie persistiert; öffentliche Seite liest nur über `resolveShareToken`; keine Org-Enumeration; IP-Handling dokumentiert.
