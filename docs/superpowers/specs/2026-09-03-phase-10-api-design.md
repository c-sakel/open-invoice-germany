# Phase 10 — REST-API (OpenAPI/Swagger) und Webhooks

**Auftrag des Betreibers (2026-09-03):** „Vollständige OpenAPI/Swagger hinzufügen, damit wir quasi alles via API machen können. Ähnlich aufgebaut wie bei sevDesk. 10b (Webhooks) direkt mit planen."

**Lastenheft-Bezug:** §50 (Zod an jeder Boundary), §51 (GoBD — keine Bypass-Pfade), §55 (gleiche Validierung wie UI/MCP), §59 DoD. Phase 10 läuft nach Phase 9; sie setzt voraus, dass alle Kernfunktionen als Domain-Funktionen existieren (Phasen 1–9).

## 1. Ist-Stand (Erwartung nach Phase 9)

- Interne Routen unter `/api/*` sind UI-Hilfsrouten (Cookie-Session, uneinheitliche Antwortformen, teils 422, teils 400/409).
- MCP-Server (`src/mcp/server.ts`) ruft Domain-Funktionen mit Zod — das ist die Blaupause für die REST-API.
- Auth ausschließlich Cookie (`src/proxy.ts`); kein API-Key-Modell; kein Rate-Limit außer Phase 3b (In-Memory).
- Kein OpenAPI-Dokument, kein Swagger.

## 2. Entscheidungen

| Frage | Entscheidung | Warum |
|---|---|---|
| Umfang | **10a REST-API + OpenAPI/Swagger**, **10b Webhooks** — zwei Pläne, eine Spec. | Betreiber-Auftrag; 10b braucht den Scheduler (Phase 6). |
| Stil „wie sevDesk" | Ressourcenorientiert, ein Pfad je Objekt, Listen mit `limit/offset` + `total`, Filter als Query-Parameter, `embed` für verschachtelte Objekte, Aktions-Endpunkte als Unterpfade (`/Invoice/{id}/finalize`). Objekte tragen `objectName` und `id` (sevDesk-Konvention), Zeitstempel ISO 8601, Geld als Integer-Cent (**nicht** sevDesks Dezimal-Strings — Lastenheft §50 gilt). | Vertraut für sevDesk-Nutzer, konsistent mit unseren Regeln. |
| Basis-Pfad | `/api/v1/` — Versionierung im Pfad; die internen UI-Routen bleiben unter `/api/` unversioniert und werden nicht Teil der öffentlichen API. | Klare Trennung, kein Bruch der UI. |
| Auth | **API-Keys je Organisation**: Modell `ApiKey { id, orgId, name, keyHash (sha256), prefix (erste 8 Zeichen zur Anzeige), scopes[], lastUsedAt, expiresAt?, revokedAt?, createdBy }`; Token `oig_<32 Byte base64url>` nur bei Erzeugung sichtbar; Header `Authorization: Bearer oig_…`; Scopes `read`, `write`, `send` (Mail/Webhook auslösen), `admin` (Keys/Settings). Session-Cookie bleibt für die UI; `/api/v1/*` akzeptiert **nur** Bearer. | Wie sevDesk (Token), aber Hash-only wie Phase 3b. |
| Rate-Limit | Je Key 600 Anfragen/min (In-Memory, Phase-3b-Modul; LIMITATIONEN: single instance); Header `X-RateLimit-Remaining`. | Missbrauchsschutz ohne neue Infrastruktur. |
| Ressourcen (10a) | `Contact` (Customer), `ContactAddress`, `ContactPerson`, `Product`, `Quote` (Angebot), `OrderConfirmation`, `DeliveryNote`, `Invoice`, `InvoiceLine` (eingebettet), `Payment`, `Dunning`, `Attachment`, `EmailLog`, `PaymentMethod`, `TextTemplate`, `EmailTemplate`, `Settings` (Org, Mail ohne Secret, Dokumente), `ApiKey`, `Webhook` (10b). | Alles, was UI/MCP können (§55). |
| Aktionen | `POST /Invoice/{id}/finalize`, `/cancel`, `/credit` (Teilgutschrift), `/payment`, `/send`, `/pdf` (GET), `/xrechnung` (GET), `/zugferd` (GET); `POST /Quote/{id}/convert` (toKind), `/status`, `/duplicate`, `/share-link`, `/send`; `POST /DeliveryNote/{id}/status`; `POST /Contact/{id}/…`. Jede Aktion ruft exakt die Domain-Funktion, die auch UI/MCP nutzen. | Kein Bypass (§51/§55). |
| Fehlerformat | `{ error: { code: "VALIDATION" \| "NOT_FOUND" \| "CONFLICT" \| "FORBIDDEN" \| "RATE_LIMITED" \| "INTERNAL", message, details? } }`; Zod → 400 mit `details.issues`; GoBD-/Statuskonflikt → 409; fehlende Berechtigung → 403; unbekannt → 404; Rate-Limit → 429 + `Retry-After`. | Einheitlich, maschinenlesbar. |
| Antwortformat | Einzelobjekt `{ data: {…} }`, Liste `{ data: […], total, limit, offset }`; `embed=customer,lines` liefert Unterobjekte inline, sonst nur IDs. Datumsfelder ISO, Geld Cent. | sevDesk-nah, aber konsistent. |
| OpenAPI | 3.1, **aus den Zod-Schemas generiert** (`@asteasolutions/zod-to-openapi` — einzige neue Abhängigkeit; Zod-4-Kompatibilität vorab prüfen, sonst `zod-openapi`), Registry in `src/api/openapi.ts`; Datei `openapi/openapi.json` im Repo, CI-Check `npm run api:check` (Generat = Datei, sonst rot); Swagger UI unter `/api/docs` (authentifiziert per Session ODER Key), roh unter `/api/v1/openapi.json`. Beispiele je Endpunkt, deutsche Beschreibungen. | Doku kann nicht driften. |
| Idempotenz | Schreibende Aktionen akzeptieren `Idempotency-Key` (Header); Modell `ApiIdempotency { orgId, key, requestHash, responseJson, createdAt }`, 24 h gültig; Wiederholung liefert dieselbe Antwort. | Netzwerk-Retries ohne Doppelbuchung (GoBD). |
| Audit | Jede schreibende API-Aktion läuft mit `actor = "api:<keyName>"` in den ChangeLog. | Nachvollziehbar, wer per API schrieb. |
| Webhooks (10b) | Modell `WebhookEndpoint { id, orgId, url (https only), secretEnc (AES-GCM), events[], isActive, createdAt }`, `WebhookDelivery { id, endpointId, eventType, payloadJson, attempt, status (PENDING/DELIVERED/FAILED/DEAD), responseCode?, responseSnippet?, nextAttemptAt?, createdAt, deliveredAt? }`. Events: `invoice.finalized`, `invoice.cancelled`, `invoice.paid`, `payment.recorded`, `quote.sent`, `quote.accepted`, `quote.rejected`, `delivery_note.created`, `email.sent`, `email.failed`, `dunning.created`. Erzeugung: Domain-Funktionen rufen `emitEvent(tx, {orgId, type, objectName, objectId})` in **derselben Transaktion** wie den ChangeLog (Outbox-Muster: Zeile in `WebhookDelivery` mit PENDING). Zustellung: Scheduler (Phase 6, `/api/cron/run-webhooks`) POSTet `{ id, type, createdAt, data: <Ressource im API-Format> }` mit Headern `X-OIG-Signature: t=<ts>,v1=<hmac-sha256(secret, ts + "." + body)>`, `X-OIG-Event`, `X-OIG-Delivery`; Timeout 10 s; Retry 5× mit Backoff 1/5/30/120/600 min, dann DEAD; UI: Endpunkte, Zustellprotokoll, „Test senden", „Erneut zustellen". | Outbox garantiert: kein Event ohne Audit, kein Audit ohne Event. |
| Sicherheit Webhooks | Nur `https://`; keine privaten/Link-Local-Ziele (SSRF-Schutz: DNS-Auflösung prüfen, 10/172.16/192.168/127/169.254/::1 verbieten); Secret nie im UI nach Erzeugung; Payload ohne `internalNotes`. | Öffentliche Ausgangsverbindungen. |
| Abgrenzung | Keine OAuth/Multi-User (Ruling: kein Mehrbenutzer in diesem Programm), keine GraphQL, keine Bulk-Endpunkte (Backlog), kein SDK-Generat (Nutzer generieren aus OpenAPI selbst). | Umfang. |

## 3. Struktur

```
src/api/            auth.ts (Bearer→ApiKey, Scopes), errors.ts (Mapping), response.ts (Envelope, Paginierung, embed),
                    openapi.ts (Registry + Generator), rate-limit.ts (Wrapper), idempotency.ts
src/app/api/v1/     <Resource>/route.ts, <Resource>/[id]/route.ts, <Resource>/[id]/<action>/route.ts, openapi.json/route.ts
src/app/api/docs/   Swagger UI (statisches HTML mit swagger-ui-dist aus node_modules oder CDN? → aus node_modules, kein CDN)
src/domain/api-key/ create/revoke/verify; src/domain/webhook/ endpoints, emit (Outbox), deliver, sign
src/app/einstellungen/api/  API-Keys + Webhooks + Link zur Doku
openapi/openapi.json, scripts/api-check.ts
```

## 4. Tests

- Auth: Key gültig/abgelaufen/widerrufen/falscher Scope/fehlender Header → 401/403; Rate-Limit 429.
- Jede Ressource: Liste (Paginierung, Filter, embed), Get, Create (Zod-Fehlerformat), Update (nur Entwürfe), Aktionen (finalize → 409 bei zweitem Aufruf; cancel; payment mit Idempotency-Key doppelt → identische Antwort, eine Buchung).
- OpenAPI: Generat entspricht Datei; jede Route in der Spec, jede Spec-Route existiert (Round-Trip-Test); Beispiel-Payloads validieren gegen die Schemas.
- Webhooks: Outbox-Zeile entsteht in derselben Tx wie der ChangeLog (Rollback-Test); Signatur verifizierbar; Retry-Backoff; DEAD nach 5; SSRF-Ziele abgelehnt; Payload ohne `internalNotes`; Replay erzeugt neue Delivery.
- Postgres-Skript: Tabellenzahl +4 (ApiKey, ApiIdempotency, WebhookEndpoint, WebhookDelivery).

## 5. Doku

`docs/API.md` (Einstieg, Auth, Beispiele mit curl für die Kernflüsse: Kunde anlegen → Rechnung anlegen → festschreiben → PDF/XRechnung → Zahlung), `docs/WEBHOOKS.md` (Events, Signaturprüfung mit Beispielcode), README-Abschnitt, LIMITATIONEN (Rate-Limit single instance, keine Bulk-API), ARCHITEKTUR (API-Schicht, Outbox).
