#!/usr/bin/env bash
# Testet den Postgres-Migrationspfad gegen einen Wegwerf-Container.
# Voraussetzung: laufender Docker-Daemon. Aufruf: ./scripts/test-postgres-migrations.sh
set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER=oig-migtest
PORT=55433
export DATABASE_URL="postgresql://oig:test@localhost:${PORT}/openinvoice?schema=public"

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

fail() { echo "FEHLGESCHLAGEN: $1" >&2; exit 1; }
TABLES_BASE=71  # Tabellenstand vor Zahlungsanbieter
TABLES_EXPECTED=$((TABLES_BASE + 5 + 4 + 2))  # Zahlungsanbieter: PaymentProviderSettings, PaymentProviderAccount, InvoicePayLink, PaymentProviderAttempt, PaymentProviderEvent (76; Stripe: nur Spalten); DATEV: 4 Tabellen (80); Eingangsrechnungen: IncomingInvoice, IncomingInvoiceValidation (82)

# Portabel: macOS hat kein timeout(1). Beendet den Befehl nach N Sekunden.
run_with_timeout() {
  local secs=$1; shift
  "$@" & local pid=$!
  ( sleep "$secs"; kill "$pid" 2>/dev/null ) & local killer=$!
  wait "$pid"; local rc=$?
  kill "$killer" 2>/dev/null; wait "$killer" 2>/dev/null || true
  return $rc
}

# Bestands-Szenarien: eine Migration per psql in EINER Transaktion einspielen und so verbuchen
# wie "prisma migrate deploy" (Pruefsumme = SHA-256 der migration.sql). Ersetzt
# zwei npx-prisma-Aufrufe je Migration; die eigentliche Pruefung jedes Szenarios laeuft
# weiterhin ueber "prisma migrate deploy". Voraussetzung: 0_init ist per Prisma verbucht
# (legt _prisma_migrations an).
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
apply_and_mark() {
  local mig=$1 file="prisma/migrations-postgres/$1/migration.sql" sum
  sum=$(sha256_of "$file")
  { cat "$file"
    printf '\n;\nINSERT INTO "_prisma_migrations" ("id","checksum","finished_at","migration_name","started_at","applied_steps_count") VALUES (gen_random_uuid()::text, '"'%s'"', now(), '"'%s'"', now(), 1);\n' "$sum" "$mig"
  } | docker exec -i "$CONTAINER" psql -1 -U oig -d openinvoice -v ON_ERROR_STOP=1 -q >/dev/null \
    || fail "Migration $mig liess sich nicht einspielen"
}

echo "==> Wegwerf-PostgreSQL starten"
docker run -d --name "$CONTAINER" \
  -e POSTGRES_USER=oig -e POSTGRES_PASSWORD=test -e POSTGRES_DB=openinvoice \
  -p "${PORT}:5432" postgres:16-alpine >/dev/null
ready=0
for _ in $(seq 1 60); do
  docker exec "$CONTAINER" pg_isready -U oig -d openinvoice >/dev/null 2>&1 && { ready=1; break; }
  sleep 1
done
[ "$ready" = "1" ] || fail "PostgreSQL wurde nicht bereit"

echo "==> Fall 1: frische Datenbank"
run_with_timeout 120 ./scripts/db-prepare.sh >/dev/null
COUNT=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT" = "$TABLES_EXPECTED" ] || fail "erwartet ${TABLES_EXPECTED} Tabellen, gefunden $COUNT"
echo "    ok — ${TABLES_EXPECTED} Tabellen angelegt (inkl. _prisma_migrations; Phase 7: BrandingSettings, PrintSettings; Phase 8a: CustomFieldDefinition; Phase 8b: ActivityLog, Notification, NotificationSettings; Phase 10: ApiKey, ApiIdempotency, WebhookEndpoint, WebhookDelivery; Phase 12d: ApiRequestLog, ApiSettings; Phase 13d: DocumentTemplate, Tag, DocumentTag; Phase 14a: BaseInterestRate; Phase 16a: ArchivedDocument, ChainVerification, SystemMarker; Phase 16b: ExchangeRate; Phase 17a: VatIdCheck; Phase 17d: RecoveryCode, PasswordResetToken; Phase 16d: PostalSettings, PostalJob, PostalJobEvent; Phase 18f: RecurringUsage; Kundenportal: CustomerPortalSettings, CustomerPortalLink, CustomerPortalEvent; Bankabgleich: BankStatementImport, BankTransaction, BankMatch, BankCounterpartyHint; Zahlungsaktionen: PaymentRule, PaymentRuleRun; Zahlungsanbieter: PaymentProviderSettings, PaymentProviderAccount, InvoicePayLink, PaymentProviderAttempt, PaymentProviderEvent; DATEV: DatevSettings, DatevAccountMapping, DatevExport, DatevExportItem)"

echo "==> Datenbank leeren und Bestandslage herstellen"
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
# Bestands-DB = exakt der Baseline-Stand, ohne Migrationshistorie und ohne spaetere Spalten.
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
# Legacy-Belege fuer den Backfill-Test (Fall 5): Organisation, Kunde, festgeschriebene Rechnung.
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org1','Müller & Söhne GmbH','Weg 1','12345','Lüneburg',NOW());
INSERT INTO "Customer" ("id","orgId","name","addressLine1","postalCode","city","updatedAt")
  VALUES ('cust1','org1','O''Brien AG','Str. 2','54321','Altdorf',NOW());
INSERT INTO "Invoice" ("id","orgId","customerId","number","status","updatedAt")
  VALUES ('inv1','org1','cust1','RE-2026-00001','FINALIZED',NOW());
INSERT INTO "Quote" ("id","orgId","customerId","kind","number","status","convertedToInvoiceId","updatedAt")
  VALUES ('q1','org1','cust1','ANGEBOT','AN-2026-0001','CONVERTED','inv1',NOW());
INSERT INTO "Quote" ("id","orgId","customerId","kind","number","status","convertedToInvoiceId","updatedAt")
  VALUES ('q2','org1','cust1','ANGEBOT','AN-2026-0002','CONVERTED','inv1',NOW());
-- q3: Legacy-Angebot mit einem Status, der von der Phase-3a-Backfill-Zeile (CONVERTED->
-- ACCEPTED) NICHT betroffen ist -- muss unveraendert 'SENT' bleiben (Task-6-Ergaenzung).
INSERT INTO "Quote" ("id","orgId","customerId","kind","number","status","convertedToInvoiceId","updatedAt")
  VALUES ('q3','org1','cust1','ANGEBOT','AN-2026-0003','SENT',NULL,NOW());
INSERT INTO "Payment" ("id","invoiceId","amountCents","method") VALUES ('pay1','inv1',100,'TRANSFER');
INSERT INTO "Dunning" ("id","invoiceId","level") VALUES ('dun1','inv1',1);
SQL

echo "==> Fall 2: Bestands-DB ohne Historie wird erkannt"
if OUT=$(run_with_timeout 120 ./scripts/db-prepare.sh 2>&1); then
  fail "db-prepare.sh haette abbrechen muessen"
fi
printf '%s' "$OUT" | grep -q "migrate resolve" \
  || fail "Abbruchmeldung nennt den noetigen Befehl nicht"
COUNT=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT" = "14" ] || fail "db-prepare.sh hat die Daten veraendert ($COUNT Tabellen)"
echo "    ok — abgebrochen, Daten unveraendert"

echo "==> Fall 3: nach Baseline laeuft deploy durch"
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "deploy nach Baseline fehlgeschlagen"
npx prisma migrate deploy --config prisma.postgres.config.ts 2>&1 \
  | grep -q "No pending migrations" || fail "zweiter deploy war nicht wirkungslos"
MAILSETTINGS=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select to_regclass('\"MailSettings\"') is not null")
[ "$MAILSETTINGS" = "t" ] || fail "Tabelle MailSettings fehlt nach deploy"
IDX=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from pg_indexes where indexname='EmailTemplate_orgId_docType_language_name_key'")
[ "$IDX" = "1" ] || fail "Index EmailTemplate_orgId_docType_language_name_key fehlt nach deploy"
OLDIDX1=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from pg_indexes where indexname='EmailTemplate_orgId_docType_name_key'")
[ "$OLDIDX1" = "0" ] || fail "alter Index EmailTemplate_orgId_docType_name_key nach deploy noch vorhanden"
# Phase 5: zwei Migrationen (phase5_partial_invoices + invoice_line_source_line_id) muessen
# beide angewendet sein (FinalInvoiceDeduction-Tabelle + InvoiceLine.sourceLineId-Spalte).
FID=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select to_regclass('\"FinalInvoiceDeduction\"') is not null")
[ "$FID" = "t" ] || fail "Tabelle FinalInvoiceDeduction fehlt nach deploy"
FIDUNIQUE=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from pg_indexes where indexname='FinalInvoiceDeduction_finalInvoiceId_downpaymentInvoiceId_t_key'")
[ "$FIDUNIQUE" = "1" ] || fail "Unique-Index auf FinalInvoiceDeduction fehlt nach deploy"
SRCLINE=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from information_schema.columns where table_name='InvoiceLine' and column_name='sourceLineId'")
[ "$SRCLINE" = "1" ] || fail "InvoiceLine.sourceLineId fehlt nach deploy"
PHASE5MIG=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from _prisma_migrations where migration_name in ('20260903223413_phase5_partial_invoices','20260903225405_invoice_line_source_line_id') and finished_at is not null")
[ "$PHASE5MIG" = "2" ] || fail "erwartet beide Phase-5-Migrationen als angewendet in _prisma_migrations, gefunden $PHASE5MIG"
echo "    ok — Baseline verbucht, Folgemigrationen angewendet (inkl. beider Phase-5-Migrationen), deploy idempotent, MailSettings/EmailTemplate-Index/FinalInvoiceDeduction vorhanden"

echo "==> Fall 4: db-prepare.sh nach Baseline ist wirkungslos"
OUT=$(run_with_timeout 120 ./scripts/db-prepare.sh 2>&1) \
  || fail "db-prepare.sh haette mit Exit 0 durchlaufen sollen"
printf '%s' "$OUT" | grep -q "No pending migrations" \
  || fail "db-prepare.sh hat keine ausstehenden Migrationen gemeldet"
echo "    ok — db-prepare.sh laeuft nach Baseline sauber durch"

echo "==> Fall 5: Backfill friert Legacy-Belege ein"
SRC=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select \"snapshotSource\" from \"Invoice\" where id='inv1'")
[ "$SRC" = "MIGRATION" ] || fail "snapshotSource ist '$SRC', erwartet MIGRATION"
NAME=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select (\"buyerSnapshotJson\"::jsonb)->>'name' from \"Invoice\" where id='inv1'")
[ "$NAME" = "O'Brien AG" ] || fail "Buyer-Snapshot enthaelt $NAME, erwartet O'Brien AG"
KEYS=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from \"Invoice\", jsonb_object_keys(\"sellerSnapshotJson\"::jsonb) where id='inv1'" 2>/dev/null || echo 0)
[ "$KEYS" = "14" ] || fail "Seller-Snapshot hat $KEYS Schluessel, erwartet 14"
BKEYS=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from \"Invoice\", jsonb_object_keys(\"buyerSnapshotJson\"::jsonb) where id='inv1'" 2>/dev/null || echo 0)
[ "$BKEYS" = "10" ] || fail "Buyer-Snapshot hat $BKEYS Schluessel, erwartet 10"
echo "    ok — Backfill mit Herkunft MIGRATION, JSON gueltig"

echo "==> Fall 6: Phase-1-Backfill (Relationen, Stammdaten, Mahnstufen, Legacy-Quote-Status)"
REL=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select \"relationType\" from \"DocumentRelation\" where \"fromId\"='q1'")
[ "$REL" = "CONVERTED_TO" ] || fail "Relation fuer q1 fehlt ('$REL')"
Q1STATUS=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select status from \"Quote\" where id='q1'")
[ "$Q1STATUS" = "ACCEPTED" ] || fail "q1 hat Status '$Q1STATUS', erwartet ACCEPTED (Phase-3a-Backfill CONVERTED->ACCEPTED)"
Q2STATUS=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select status from \"Quote\" where id='q2'")
[ "$Q2STATUS" = "ACCEPTED" ] || fail "q2 hat Status '$Q2STATUS', erwartet ACCEPTED (Phase-3a-Backfill CONVERTED->ACCEPTED)"
Q3STATUS=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select status from \"Quote\" where id='q3'")
[ "$Q3STATUS" = "SENT" ] || fail "q3 hat Status '$Q3STATUS', erwartet unveraendert SENT (Backfill betrifft nur CONVERTED)"
CONVCOUNT=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from \"DocumentRelation\" where \"relationType\"='CONVERTED_TO' and \"fromType\"='QUOTE'")
[ "$CONVCOUNT" = "2" ] || fail "erwartet 2 CONVERTED_TO-Relationen (q1, q2), gefunden $CONVCOUNT"
PM=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from \"PaymentMethod\" where \"orgId\"='org1'")
[ "$PM" = "10" ] || fail "erwartet 10 Zahlungsmethoden (Backfill legt SKONTO und ONLINE an), gefunden $PM"
DS=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from \"DunningStage\" where \"orgId\"='org1'")
[ "$DS" = "4" ] || fail "erwartet 4 Mahnstufen, gefunden $DS"
ST=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"stageId\" from \"Dunning\" where id='dun1'")
EXP=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select id from \"DunningStage\" where \"orgId\"='org1' and \"order\"=1")
[ -n "$ST" ] && [ "$ST" = "$EXP" ] || fail "Dunning dun1 hat stageId '$ST', erwartet Stufe order=1 ('$EXP')"
echo "    ok — Backfill vollstaendig, Legacy-Quotes q1/q2 (CONVERTED) nach ACCEPTED migriert, q3 (SENT) unveraendert"

echo "==> Fall 7 (Phase 5): FinalInvoiceDeduction — Insert + Unique-Constraint"
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Invoice" ("id","orgId","customerId","number","status","type","prepaidCents","payableCents","updatedAt")
  VALUES ('dp1','org1','cust1','RE-2026-00002','FINALIZED','DOWNPAYMENT',0,NULL,NOW());
INSERT INTO "Invoice" ("id","orgId","customerId","number","status","type","prepaidCents","payableCents","updatedAt")
  VALUES ('fin1','org1','cust1','RE-2026-00003','FINALIZED','FINAL',357000,833000,NOW());
INSERT INTO "FinalInvoiceDeduction"
  ("id","finalInvoiceId","downpaymentInvoiceId","number","issueDate","netCents","taxCents","grossCents","taxRate","taxCategory")
  VALUES ('fid1','fin1','dp1','RE-2026-00002',NOW(),300000,57000,357000,19,'S');
SQL
FIDCOUNT=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from \"FinalInvoiceDeduction\" where id='fid1'")
[ "$FIDCOUNT" = "1" ] || fail "FinalInvoiceDeduction-Zeile wurde nicht angelegt"
if docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL' >/dev/null 2>&1
INSERT INTO "FinalInvoiceDeduction"
  ("id","finalInvoiceId","downpaymentInvoiceId","number","issueDate","netCents","taxCents","grossCents","taxRate","taxCategory")
  VALUES ('fid2','fin1','dp1','RE-2026-00002',NOW(),300000,57000,357000,19,'S');
SQL
then
  fail "zweite FinalInvoiceDeduction-Zeile mit gleichem (finalInvoiceId, downpaymentInvoiceId, taxRate, taxCategory) haette am Unique-Constraint scheitern muessen"
fi
echo "    ok — FinalInvoiceDeduction angelegt, Duplikat (finalInvoiceId, downpaymentInvoiceId, taxRate, taxCategory) vom Unique-Constraint abgewiesen"

echo "==> Fall 8 (Phase 6): Mahnwesen/Scheduler — Migrationen, Unique-Index, Defaults"
PHASE6MIG=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from _prisma_migrations where migration_name in ('20260904021504_phase6_dunning','20260904031045_phase6_scheduler_lock') and finished_at is not null")
[ "$PHASE6MIG" = "2" ] || fail "erwartet beide Phase-6-Migrationen als angewendet in _prisma_migrations, gefunden $PHASE6MIG"
for TBL in DunningStage DunningSettings SchedulerRun SchedulerLock; do
  EXISTS=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select to_regclass('\"$TBL\"') is not null")
  [ "$EXISTS" = "t" ] || fail "Tabelle $TBL fehlt nach deploy"
done
DUNIDX=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from pg_indexes where indexname='Dunning_invoiceId_stageId_key'")
[ "$DUNIDX" = "1" ] || fail "Unique-Index Dunning_invoiceId_stageId_key fehlt nach deploy"
AUTOSENDDEFAULT=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select column_default from information_schema.columns where table_name='DunningStage' and column_name='autoSend'")
[ "$AUTOSENDDEFAULT" = "false" ] || fail "DunningStage.autoSend hat Default '$AUTOSENDDEFAULT', erwartet false"
# DunningSettings entsteht per Selbstheilung (loadDunningSettings, upsert) — keine SQL-seitige
# Row hier; geprueft werden Tabellen-Existenz + Spalten-Defaults, nicht ein tatsaechlicher
# Datensatz (siehe Task-5-Facts).
DS_AUTOCREATE=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select column_default from information_schema.columns where table_name='DunningSettings' and column_name='autoCreate'")
[ "$DS_AUTOCREATE" = "true" ] || fail "DunningSettings.autoCreate hat Default '$DS_AUTOCREATE', erwartet true"
DS_AUTOSEND=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select column_default from information_schema.columns where table_name='DunningSettings' and column_name='autoSend'")
[ "$DS_AUTOSEND" = "false" ] || fail "DunningSettings.autoSend hat Default '$DS_AUTOSEND', erwartet false"
DS_BASERATE=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select column_default from information_schema.columns where table_name='DunningSettings' and column_name='baseInterestRateBp'")
[ "$DS_BASERATE" = "127" ] || fail "DunningSettings.baseInterestRateBp hat Default '$DS_BASERATE', erwartet 127"
# Unique-Index (invoiceId, stageId) tatsaechlich erzwungen: dun1 (Fall 6) hat bereits eine
# stageId; eine zweite Mahnung derselben Rechnung auf derselbe Stufe muss scheitern.
DUN1STAGE=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"stageId\" from \"Dunning\" where id='dun1'")
if docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<SQL >/dev/null 2>&1
INSERT INTO "Dunning" ("id","invoiceId","level","stageId") VALUES ('dun2','inv1',1,'$DUN1STAGE');
SQL
then
  fail "zweite Dunning-Zeile mit gleichem (invoiceId, stageId) haette am Unique-Constraint scheitern muessen"
fi
echo "    ok — beide Phase-6-Migrationen angewendet, DunningStage/DunningSettings/SchedulerRun/SchedulerLock vorhanden, Unique-Index Dunning(invoiceId,stageId) erzwungen, autoSend-Defaults korrekt (Stufe false, Settings-Spalten autoCreate=true/autoSend=false/baseInterestRateBp=127)"

echo "==> Fall 9 (Phase 7): DocumentSettings-Defaults fuer Bestandszeile, neue Tabellen, Customer-Index"
# Eigenes Bestands-Szenario: DB exakt auf dem Stand VOR der Phase-7-Migration bringen
# (0_init + alle Migrationen bis einschliesslich Phase 6, jede einzeln per apply_and_mark
# angewendet und verbucht — KEIN "migrate deploy", das
# wuerde alle ausstehenden Migrationen inkl. Phase 7 in einem Rutsch anwenden). Die
# Fix-Welle-Migration (phase8b_fixwave) wird HIER ebenfalls ausgeklammert (nicht nur
# Phase 7): ihr Backfill liest DocumentSettings.recurringInsertPeriodText, eine Spalte,
# die erst Phase 7 anlegt — wuerde die Schleife sie roh anwenden, BEVOR Phase 7 (das hier
# absichtlich zurueckgehalten wird) die Spalte angelegt hat, schlaegt das UPDATE mit
# "column does not exist" fehl. Danach eine Organisation + eine DocumentSettings-Zeile im
# ALTEN Spaltenumfang anlegen und erst dann per "migrate deploy" Phase 7 UND die
# Fix-Welle-Migration in der richtigen Reihenfolge nachziehen — so laesst sich pruefen,
# dass ALTER TABLE ... ADD COLUMN ... DEFAULT die neuen Spalten auch auf einer bereits
# existierenden Zeile korrekt befuellt (nicht nur auf frisch angelegten Zeilen). Die
# eigentliche Backfill-Pruefung fuer die Fix-Welle-Migration folgt gesondert in Fall 13
# (eigenes, isoliertes Bestands-Szenario mit einer RecurringInvoice-Zeile).
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
# Phase 11b: beide Layout-Migrationen aendern BrandingSettings (legt Phase 7 an) — hier
# ebenfalls ausklammern, der anschliessende "migrate deploy" zieht sie in der richtigen
# Reihenfolge nach Phase 7 nach. Phase 12a: die GiroCode-Groesse-Migration aendert
# PrintSettings, ebenfalls eine Phase-7-Tabelle, die hier absichtlich noch nicht existiert
# — ebenso ausgeklammert, sonst P1014. Phase 12c: die Marken-Migration UND die Steuersatz-
# Migration aendern ebenfalls Phase-7-Tabellen (BrandingSettings bzw. DocumentSettings) —
# aus demselben Grund ausgeklammert.
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20260904044136_phase7_settings|20260904140030_phase8b_fixwave|20260907075900_phase11b_layouts|20260907090333_phase11b_footermode_backfill|20260908090100_phase12a_giro_size|20260910090100_phase12c_branding_marke|20260910091100_phase12c_tax_rates|20261111090100_phase16a_gobd_betrieb|20261112090100_phase16b_ausland|20261113090100_phase16e_oss|20261114090100_phase16g_layout|20261115090100_phase17a_erechnung|20261116090100_phase17d_auth|20261117090100_phase16d_postal|20261118090100_phase18c_belegfluss|20261119090100_phase18e_payment_means|20261119100100_phase18d_api_indexes|20261120090100_phase18f_usage|20261121090100_kundenportal|20261122090100_bankabgleich|20261123090100_sammelrechnung|20261124090100_zahlungsaktionen|20261125090100_zahlungsanbieter|20261126090100_stripe|20261127090100_datev|20261128090100_pflichtpruefungen|20261129090100_eingangsrechnungen|20261130090100_eingang_ablauf)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org9','Bestand GmbH','Altweg 9','99999','Bestadt',NOW());
INSERT INTO "DocumentSettings" ("id","orgId","onQuoteAccept","shareLinkDays","storeAcceptIp","updatedAt")
  VALUES ('ds9','org9','NONE',30,false,NOW());
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Phase-7-Migration ist auf der Bestands-DB fehlgeschlagen"
PHASE7MIG=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from _prisma_migrations where migration_name='20260904044136_phase7_settings' and finished_at is not null")
[ "$PHASE7MIG" = "1" ] || fail "Phase-7-Migration ist nicht als angewendet verbucht"
DUEDAYS=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select \"invoiceDueDays\" from \"DocumentSettings\" where id='ds9'")
[ "$DUEDAYS" = "14" ] || fail "Bestandszeile ds9: invoiceDueDays ist '$DUEDAYS', erwartet Default 14"
CURRENCY=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select \"defaultCurrency\" from \"DocumentSettings\" where id='ds9'")
[ "$CURRENCY" = "EUR" ] || fail "Bestandszeile ds9: defaultCurrency ist '$CURRENCY', erwartet Default EUR"
QVALID=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select \"quoteValidityDays\" from \"DocumentSettings\" where id='ds9'")
[ "$QVALID" = "30" ] || fail "Bestandszeile ds9: quoteValidityDays ist '$QVALID', erwartet Default 30"
BOOLDEFAULTS=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select \"autoFinalizeOnSend\",\"shareLinkDefaultOn\",\"dnShowPrices\",\"dnShowArticleNumber\",\"dnShowDeliveryAddress\",\"showPaymentTermsText\",\"autoDeliveryDate\",\"refreshIssueDateOnFinalize\",\"offerLastDocument\",\"eInvoiceDefault\",\"recurringAutoFinalizeDefault\",\"recurringAutoSendDefault\",\"recurringInsertPeriodText\" from \"DocumentSettings\" where id='ds9'")
[ "$BOOLDEFAULTS" = "f|t|f|t|t|t|t|t|t|t|f|f|t" ] \
  || fail "Bestandszeile ds9: Bool-Defaults abweichend ('$BOOLDEFAULTS')"
PMID=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select \"defaultPaymentMethodId\" from \"DocumentSettings\" where id='ds9'")
[ -z "$PMID" ] || fail "Bestandszeile ds9: defaultPaymentMethodId ist '$PMID', erwartet NULL"
for TBL in BrandingSettings PrintSettings; do
  EXISTS=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select to_regclass('\"$TBL\"') is not null")
  [ "$EXISTS" = "t" ] || fail "Tabelle $TBL fehlt nach der Phase-7-Migration"
done
ROWS=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select (select count(*) from \"BrandingSettings\") + (select count(*) from \"PrintSettings\")")
[ "$ROWS" = "0" ] || fail "BrandingSettings/PrintSettings haben bereits Zeilen ($ROWS) — diese entstehen erst per Selbstheilung zur Laufzeit, nicht per Migration"
CUSTIDX=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from pg_indexes where indexname='Customer_orgId_customerNumber_idx'")
[ "$CUSTIDX" = "1" ] || fail "Index Customer_orgId_customerNumber_idx fehlt nach der Phase-7-Migration"
for COL in Invoice:printOptionsJson Quote:printOptionsJson DeliveryNote:printOptionsJson; do
  TBL=${COL%%:*}; CNAME=${COL##*:}
  PRESENT=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
    "select count(*) from information_schema.columns where table_name='$TBL' and column_name='$CNAME'")
  [ "$PRESENT" = "1" ] || fail "Spalte $TBL.$CNAME fehlt nach der Phase-7-Migration"
done
echo "    ok — Phase-7-Migration auf einer Bestands-DB angewendet, DocumentSettings-Bestandszeile hat alle neuen Defaults, BrandingSettings/PrintSettings existieren (leer), Customer-Index und printOptionsJson-Spalten vorhanden"

echo "==> Fall 10 (Fix-Welle B3/S1): NumberRange.isActive-Default, Customer.defaultPaymentTermsDays nullable, aktive-Zeile-Switch"
ISACTIVE_DEFAULT=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select column_default from information_schema.columns where table_name='NumberRange' and column_name='isActive'")
echo "$ISACTIVE_DEFAULT" | grep -q "^true" || fail "NumberRange.isActive hat Default '$ISACTIVE_DEFAULT', erwartet true"
PTD_NULLABLE=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select is_nullable from information_schema.columns where table_name='Customer' and column_name='defaultPaymentTermsDays'")
[ "$PTD_NULLABLE" = "YES" ] || fail "Customer.defaultPaymentTermsDays ist NOT NULL, erwartet nullable (B3-Fix-Welle S1)"
PTD_DEFAULT=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select column_default from information_schema.columns where table_name='Customer' and column_name='defaultPaymentTermsDays'")
[ -z "$PTD_DEFAULT" ] || fail "Customer.defaultPaymentTermsDays hat noch einen DB-Default ('$PTD_DEFAULT'), erwartet keinen (NULL = kein Kunden-Override)"
# Aktive-Zeile-Switch (wie updateNumberRange ihn erzeugt): zwei Zeilen desselben docType
# (year 0 und year <Jahr>) — nur eine darf gleichzeitig aktiv sein, isActive schaltet um.
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL' >/dev/null
INSERT INTO "NumberRange" ("id","orgId","docType","year","currentValue","isActive","updatedAt")
  VALUES ('nr1','org9','INVOICE',0,4999,true,NOW());
INSERT INTO "NumberRange" ("id","orgId","docType","year","currentValue","isActive","updatedAt")
  VALUES ('nr2','org9','INVOICE',2026,0,false,NOW());
UPDATE "NumberRange" SET "isActive" = false WHERE id = 'nr1';
UPDATE "NumberRange" SET "isActive" = true WHERE id = 'nr2';
SQL
ACTIVE_COUNT=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from \"NumberRange\" where \"orgId\"='org9' and \"docType\"='INVOICE' and \"isActive\"=true")
[ "$ACTIVE_COUNT" = "1" ] || fail "erwartet genau 1 aktive NumberRange-Zeile nach dem Switch, gefunden $ACTIVE_COUNT"
ACTIVE_YEAR=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select year from \"NumberRange\" where \"orgId\"='org9' and \"docType\"='INVOICE' and \"isActive\"=true")
[ "$ACTIVE_YEAR" = "2026" ] || fail "aktive Zeile hat year='$ACTIVE_YEAR', erwartet 2026 nach dem Switch"
echo "    ok — NumberRange.isActive Default true, Customer.defaultPaymentTermsDays nullable ohne Default, aktive-Zeile-Switch (year 0 -> year <Jahr>) funktioniert"

echo "==> Fall 11 (Phase 8a): Kundendomain — Migration angewendet, CustomFieldDefinition-Unique, Customer-Defaults, DeliveryNote-FKs SetNull"
PHASE8AMIG=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from _prisma_migrations where migration_name='20260904091901_phase8a_customer' and finished_at is not null")
[ "$PHASE8AMIG" = "1" ] || fail "Phase-8a-Migration ist nicht als angewendet verbucht"
EXISTS=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select to_regclass('\"CustomFieldDefinition\"') is not null")
[ "$EXISTS" = "t" ] || fail "Tabelle CustomFieldDefinition fehlt nach der Phase-8a-Migration"
CFDUNIQUE=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from pg_indexes where indexname='CustomFieldDefinition_orgId_key_key'")
[ "$CFDUNIQUE" = "1" ] || fail "Unique-Index CustomFieldDefinition_orgId_key_key fehlt nach der Phase-8a-Migration"
# Fall 9 hat das Schema neu aufgesetzt (nur org9 existiert dort noch) — eigener Kunde fuer
# diesen Block, org9 wiederverwendet.
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Customer" ("id","orgId","name","addressLine1","postalCode","city","updatedAt")
  VALUES ('cust9','org9','Acht-A GmbH','Weg 9','99998','Bestadt',NOW());
INSERT INTO "CustomFieldDefinition" ("id","orgId","key","label","type","updatedAt")
  VALUES ('cfd1','org9','branche','Branche','TEXT',NOW());
SQL
if docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL' >/dev/null 2>&1
INSERT INTO "CustomFieldDefinition" ("id","orgId","key","label","type","updatedAt")
  VALUES ('cfd2','org9','branche','Branche (2)','TEXT',NOW());
SQL
then
  fail "zweite CustomFieldDefinition mit gleichem (orgId, key) haette am Unique-Constraint scheitern muessen"
fi
# Customer-Spalten-Defaults auf der frisch angelegten Zeile cust9 (Spalten existieren erst
# seit der Phase-8a-Migration, hier per normalem INSERT ohne die neuen Spalten befuellt —
# die DB-Defaults muessen greifen).
CUSTOMERDEFAULTS=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select \"defaultDiscountPermille\",\"eInvoicePreferred\",\"language\" from \"Customer\" where id='cust9'")
[ "$CUSTOMERDEFAULTS" = "0|f|de" ] \
  || fail "Kunde cust9: Customer-Defaults abweichend ('$CUSTOMERDEFAULTS'), erwartet '0|f|de'"
# DeliveryNote-FKs SetNull: Adresse + Ansprechpartner anlegen, per Lieferschein referenzieren,
# dann loeschen — die FK-Spalten muessen auf NULL fallen statt die Loeschung zu blockieren.
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "CustomerAddress" ("id","orgId","customerId","type","addressLine1","postalCode","city","updatedAt")
  VALUES ('addr1','org9','cust9','SHIPPING','Lieferweg 3','67890','Bremen',NOW());
INSERT INTO "ContactPerson" ("id","orgId","customerId","firstName","lastName","updatedAt")
  VALUES ('cp1','org9','cust9','Erika','Musterfrau',NOW());
INSERT INTO "DeliveryNote" ("id","orgId","customerId","status","shippingAddressId","contactPersonId","updatedAt")
  VALUES ('dn1','org9','cust9','DRAFT','addr1','cp1',NOW());
DELETE FROM "CustomerAddress" WHERE id = 'addr1';
DELETE FROM "ContactPerson" WHERE id = 'cp1';
SQL
DNFKS=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select coalesce(\"shippingAddressId\",'NULL')||'|'||coalesce(\"contactPersonId\",'NULL') from \"DeliveryNote\" where id='dn1'")
[ "$DNFKS" = "NULL|NULL" ] || fail "DeliveryNote dn1 nach Loeschen von Adresse/Kontakt: '$DNFKS', erwartet 'NULL|NULL' (SetNull)"
echo "    ok — Phase-8a-Migration angewendet, CustomFieldDefinition-Unique (orgId, key) erzwungen, Customer-Defaults auf Bestandszeile korrekt, DeliveryNote.shippingAddressId/contactPersonId per SetNull auf NULL gesetzt"

echo "==> Fall 12 (Phase 8b): ActivityLog/Notification/NotificationSettings, RecurringInvoice-Erweiterungen, Payment.note"
# Beide Phase-8b-Migrationen liegen bereits im Verzeichnis prisma/migrations-postgres und
# wurden dadurch schon von der Schleife in Fall 9 (0_init + alle Migrationen bis auf
# Phase 7 einzeln per apply_and_mark) mit angewendet — kein
# weiterer deploy-Schritt hier noetig, analog Fall 11 (Phase 8a). Die Fix-Welle-Migration
# (phase8b_fixwave, aus demselben Grund wie Phase 7 aus der Schleife ausgeklammert, siehe
# Kommentar in Fall 9) wurde durch Fall 9s "migrate deploy" ebenfalls schon mit angewendet
# (leeres Backfill — noch keine RecurringInvoice-Zeile zu diesem Zeitpunkt) — deshalb
# prueft dieser Block bereits den NEUEN (orgId, dedupeKey)-Index statt des alten globalen.
# Die eigentliche Backfill-Pruefung (bestehende Zeile wird umgestellt) folgt in Fall 13.
PHASE8BMIG=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from _prisma_migrations where migration_name in ('20260904115512_phase8b_workflow','20260904124324_phase8b_activity_notifications') and finished_at is not null")
[ "$PHASE8BMIG" = "2" ] || fail "erwartet beide Phase-8b-Migrationen als angewendet in _prisma_migrations, gefunden $PHASE8BMIG"
for TBL in ActivityLog Notification NotificationSettings; do
  EXISTS=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select to_regclass('\"$TBL\"') is not null")
  [ "$EXISTS" = "t" ] || fail "Tabelle $TBL fehlt nach den Phase-8b-Migrationen"
done
ACTIDX=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from pg_indexes where indexname='ActivityLog_orgId_entityType_entityId_at_idx'")
[ "$ACTIDX" = "1" ] || fail "Index ActivityLog_orgId_entityType_entityId_at_idx fehlt"
DEDUPEUNIQUE=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from pg_indexes where indexname='Notification_orgId_dedupeKey_key'")
[ "$DEDUPEUNIQUE" = "1" ] || fail "Unique-Index Notification_orgId_dedupeKey_key fehlt (Fix-Welle: schon zu diesem Zeitpunkt org-gescopt statt global, siehe Kommentar oben)"
NOTIFIDX=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from pg_indexes where indexname='Notification_orgId_readAt_createdAt_idx'")
[ "$NOTIFIDX" = "1" ] || fail "Index Notification_orgId_readAt_createdAt_idx fehlt"
NSUNIQUE=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from pg_indexes where indexname='NotificationSettings_orgId_key'")
[ "$NSUNIQUE" = "1" ] || fail "Unique-Index NotificationSettings_orgId_key fehlt"
# Notification.dedupeKey unique tatsaechlich erzwungen: zwei Zeilen mit gleichem dedupeKey
# muessen scheitern (Dedupe-Mechanismus von createNotification beruht darauf).
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL' >/dev/null
INSERT INTO "Notification" ("id","orgId","type","title","dedupeKey")
  VALUES ('notif1','org9','INVOICE_OVERDUE','Test','DEDUPE:test1');
SQL
if docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL' >/dev/null 2>&1
INSERT INTO "Notification" ("id","orgId","type","title","dedupeKey")
  VALUES ('notif2','org9','INVOICE_OVERDUE','Test 2','DEDUPE:test1');
SQL
then
  fail "zweite Notification mit gleichem dedupeKey haette am Unique-Constraint scheitern muessen"
fi
# RecurringInvoice-Erweiterungen (maxRuns/emailTemplateId nullable ohne Default,
# showPeriodText NOT NULL DEFAULT true) auf einer Bestandszeile (org9/cust9 aus Fall 11).
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL' >/dev/null
INSERT INTO "RecurringInvoice" ("id","orgId","customerId","title","startDate","nextRunDate","updatedAt")
  VALUES ('rec1','org9','cust9','Wartungsvertrag','2026-01-01','2026-02-01',NOW());
SQL
RECDEFAULTS=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select \"maxRuns\",\"emailTemplateId\",\"showPeriodText\" from \"RecurringInvoice\" where id='rec1'")
[ "$RECDEFAULTS" = "||t" ] \
  || fail "RecurringInvoice rec1: maxRuns/emailTemplateId/showPeriodText abweichend ('$RECDEFAULTS'), erwartet '||t' (maxRuns/emailTemplateId NULL, showPeriodText true)"
RECEMAILIDX=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from pg_indexes where indexname='RecurringInvoice_emailTemplateId_idx'")
[ "$RECEMAILIDX" = "1" ] || fail "Index RecurringInvoice_emailTemplateId_idx fehlt"
# Payment.note (nullable, kein Default) — auf einer Bestandszeile befuellen und lesen.
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL' >/dev/null
INSERT INTO "Invoice" ("id","orgId","customerId","number","status","updatedAt")
  VALUES ('inv9','org9','cust9','RE-2026-00009','FINALIZED',NOW());
INSERT INTO "Payment" ("id","invoiceId","amountCents","method","note") VALUES ('pay9','inv9',5000,'TRANSFER','Teilzahlung telefonisch avisiert');
SQL
PAYNOTE=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"note\" from \"Payment\" where id='pay9'")
[ "$PAYNOTE" = "Teilzahlung telefonisch avisiert" ] || fail "Payment.note ist '$PAYNOTE', erwartet 'Teilzahlung telefonisch avisiert'"
echo "    ok — beide Phase-8b-Migrationen angewendet, ActivityLog/Notification/NotificationSettings vorhanden, Notification.dedupeKey-Unique erzwungen, ActivityLog-/Notification-Indizes vorhanden, RecurringInvoice-Erweiterungen (maxRuns/emailTemplateId/showPeriodText) und Payment.note korrekt"

echo "==> Fall 13 (Fix-Welle Phase 8b): showPeriodText-Backfill aus DocumentSettings.recurringInsertPeriodText, Notification.dedupeKey org-gescopt"
# Eigenes Bestands-Szenario (analog Fall 9/Phase 7): DB exakt auf dem Stand VOR der
# Fix-Welle-Migration bringen (0_init + alle Migrationen bis einschliesslich der zweiten
# Phase-8b-Migration, jede einzeln per apply_and_mark), dann
# eine Organisation MIT abweichendem DocumentSettings.recurringInsertPeriodText (false)
# und ein Abo mit dem ALTEN Spalten-Default (showPeriodText=true) anlegen — erst danach
# per "migrate deploy" genau die Fix-Welle-Migration nachziehen, um zu pruefen, dass der
# Backfill eine BESTEHENDE Zeile tatsaechlich umstellt (nicht nur frisch angelegte).
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20260904140030_phase8b_fixwave)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org10','Bestand Zehn GmbH','Zehnweg 10','99910','Bestadt',NOW());
INSERT INTO "DocumentSettings" ("id","orgId","onQuoteAccept","shareLinkDays","storeAcceptIp","recurringInsertPeriodText","updatedAt")
  VALUES ('ds10','org10','NONE',30,false,false,NOW());
INSERT INTO "Customer" ("id","orgId","name","addressLine1","postalCode","city","updatedAt")
  VALUES ('cust10','org10','Zehn-A GmbH','Weg 10','99911','Bestadt',NOW());
INSERT INTO "RecurringInvoice" ("id","orgId","customerId","title","startDate","nextRunDate","updatedAt")
  VALUES ('rec10','org10','cust10','Bestands-Abo','2026-01-01','2026-02-01',NOW());
SQL
RECSHOWBEFORE=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"showPeriodText\" from \"RecurringInvoice\" where id='rec10'")
[ "$RECSHOWBEFORE" = "t" ] || fail "Bestandszeile rec10 vor der Fix-Welle-Migration: showPeriodText ist '$RECSHOWBEFORE', erwartet Spalten-Default true"
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Fix-Welle-Migration ist auf der Bestands-DB fehlgeschlagen"
FIXWAVEMIG=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from _prisma_migrations where migration_name='20260904140030_phase8b_fixwave' and finished_at is not null")
[ "$FIXWAVEMIG" = "1" ] || fail "Fix-Welle-Migration ist nicht als angewendet verbucht"
RECSHOWAFTER=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"showPeriodText\" from \"RecurringInvoice\" where id='rec10'")
[ "$RECSHOWAFTER" = "f" ] || fail "Bestandszeile rec10 nach dem Backfill: showPeriodText ist '$RECSHOWAFTER', erwartet false (uebernommen aus DocumentSettings.recurringInsertPeriodText der Org)"
# Notification.dedupeKey: alter globaler Unique-Index weg, neuer org-gescopter Index da.
OLDIDX=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from pg_indexes where indexname='Notification_dedupeKey_key'")
[ "$OLDIDX" = "0" ] || fail "alter globaler Unique-Index Notification_dedupeKey_key haette entfernt werden muessen"
NEWIDX=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from pg_indexes where indexname='Notification_orgId_dedupeKey_key'")
[ "$NEWIDX" = "1" ] || fail "neuer Unique-Index Notification_orgId_dedupeKey_key fehlt"
# Gleicher dedupeKey, gleiche Org -> weiterhin Unique-Verstoss.
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL' >/dev/null
INSERT INTO "Notification" ("id","orgId","type","title","dedupeKey")
  VALUES ('notif10a','org10','INVOICE_OVERDUE','Test','DEDUPE:shared');
SQL
if docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL' >/dev/null 2>&1
INSERT INTO "Notification" ("id","orgId","type","title","dedupeKey")
  VALUES ('notif10b','org10','INVOICE_OVERDUE','Test 2','DEDUPE:shared');
SQL
then
  fail "zweite Notification mit gleichem (orgId, dedupeKey) haette am Unique-Constraint scheitern muessen"
fi
# Gleicher dedupeKey, ANDERE Org -> jetzt erlaubt (Nit: vorher Cross-Tenant-Kopplung ueber
# einen global unique dedupeKey).
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org11','Elf GmbH','Elfweg 11','99912','Bestadt',NOW());
INSERT INTO "Notification" ("id","orgId","type","title","dedupeKey")
  VALUES ('notif11a','org11','INVOICE_OVERDUE','Test','DEDUPE:shared');
SQL
CROSSORGCOUNT=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from \"Notification\" where \"dedupeKey\"='DEDUPE:shared'")
[ "$CROSSORGCOUNT" = "2" ] || fail "erwartet 2 Notifications mit gleichem dedupeKey ueber zwei Orgs hinweg (org-gescopter Unique-Index), gefunden $CROSSORGCOUNT"
echo "    ok — Fix-Welle-Migration angewendet, showPeriodText-Bestandszeile korrekt aus DocumentSettings.recurringInsertPeriodText befuellt, Notification.dedupeKey jetzt (orgId, dedupeKey)-eindeutig statt global"

echo "==> Fall 14 (Phase 10): REST-API/OpenAPI/Webhooks — Migrationen, +4 Tabellen, Unique-Constraints"
# Diese DB (aus Fall 13) hat bereits ALLE Migrationen angewendet (die Fall-9/13-Schleifen
# klammern jeweils nur EINE Migration aus, die per anschliessendem "migrate deploy"
# nachgezogen wird) — inkl. aller drei Phase-10-Migrationen. Hier wird nur noch verifiziert.
PHASE10MIG=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from _prisma_migrations where migration_name in ('20260904174316_phase10_api','20260904180004_phase10_api_idem','20260904205901_phase10_webhooks') and finished_at is not null")
[ "$PHASE10MIG" = "3" ] || fail "erwartet alle drei Phase-10-Migrationen als angewendet in _prisma_migrations, gefunden $PHASE10MIG"
for TBL in ApiKey ApiIdempotency WebhookEndpoint WebhookDelivery; do
  EXISTS=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select to_regclass('\"$TBL\"') is not null")
  [ "$EXISTS" = "t" ] || fail "Tabelle $TBL fehlt nach den Phase-10-Migrationen"
done
COUNT10=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT10" = "$TABLES_EXPECTED" ] || fail "erwartet ${TABLES_EXPECTED} Tabellen nach allen Migrationen (inkl. Phase 10), gefunden $COUNT10"
# ApiKey.keyHash unique.
APIKEYUNIQUE=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from pg_indexes where indexname='ApiKey_keyHash_key'")
[ "$APIKEYUNIQUE" = "1" ] || fail "Unique-Index ApiKey_keyHash_key fehlt"
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL' >/dev/null
INSERT INTO "ApiKey" ("id","orgId","name","keyHash","prefix","scopesJson")
  VALUES ('key1','org10','Buchhaltung','HASH_DUPLICATE_TEST','abcdefgh','["read"]');
SQL
if docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL' >/dev/null 2>&1
INSERT INTO "ApiKey" ("id","orgId","name","keyHash","prefix","scopesJson")
  VALUES ('key2','org10','Zweitschluessel','HASH_DUPLICATE_TEST','ijklmnop','["write"]');
SQL
then
  fail "zweiter ApiKey mit gleichem keyHash haette am Unique-Constraint scheitern muessen"
fi
# ApiIdempotency Unique (orgId, key).
APIIDEMUNIQUE=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from pg_indexes where indexname='ApiIdempotency_orgId_key_key'")
[ "$APIIDEMUNIQUE" = "1" ] || fail "Unique-Index ApiIdempotency_orgId_key_key fehlt"
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL' >/dev/null
INSERT INTO "ApiIdempotency" ("id","orgId","key","requestHash","status")
  VALUES ('idem1','org10','idem-key-1','hash1','DONE');
SQL
if docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL' >/dev/null 2>&1
INSERT INTO "ApiIdempotency" ("id","orgId","key","requestHash","status")
  VALUES ('idem2','org10','idem-key-1','hash2','DONE');
SQL
then
  fail "zweite ApiIdempotency-Zeile mit gleichem (orgId, key) haette am Unique-Constraint scheitern muessen"
fi
# Gleicher key, ANDERE Org -> erlaubt (org-gescopt).
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL' >/dev/null
INSERT INTO "ApiIdempotency" ("id","orgId","key","requestHash","status")
  VALUES ('idem3','org11','idem-key-1','hash1','DONE');
SQL
CROSSORGIDEM=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from \"ApiIdempotency\" where \"key\"='idem-key-1'")
[ "$CROSSORGIDEM" = "2" ] || fail "erwartet 2 ApiIdempotency-Zeilen mit gleichem key ueber zwei Orgs hinweg (org-gescopter Unique-Index), gefunden $CROSSORGIDEM"
# WebhookEndpoint + WebhookDelivery: Indizes vorhanden, FK onDelete Cascade, Zustellprotokoll.
WHIDX=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from pg_indexes where indexname='WebhookEndpoint_orgId_idx'")
[ "$WHIDX" = "1" ] || fail "Index WebhookEndpoint_orgId_idx fehlt"
WHDELIDX1=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from pg_indexes where indexname='WebhookDelivery_orgId_status_nextAttemptAt_idx'")
[ "$WHDELIDX1" = "1" ] || fail "Index WebhookDelivery_orgId_status_nextAttemptAt_idx fehlt"
WHDELIDX2=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from pg_indexes where indexname='WebhookDelivery_endpointId_createdAt_idx'")
[ "$WHDELIDX2" = "1" ] || fail "Index WebhookDelivery_endpointId_createdAt_idx fehlt"
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL' >/dev/null
INSERT INTO "WebhookEndpoint" ("id","orgId","url","secretEnc","eventsJson","updatedAt")
  VALUES ('wh1','org10','https://example.invalid/hook','enc:test','["invoice.finalized"]',NOW());
INSERT INTO "WebhookDelivery" ("id","orgId","endpointId","event","objectName","objectId","dataJson")
  VALUES ('whd1','org10','wh1','invoice.finalized','Invoice','inv-x','{}');
DELETE FROM "WebhookEndpoint" WHERE id = 'wh1';
SQL
WHDELROWS=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from \"WebhookDelivery\" where id='whd1'")
[ "$WHDELROWS" = "0" ] || fail "WebhookDelivery-Zeile haette per ON DELETE CASCADE mit dem Endpunkt geloescht werden muessen"
echo "    ok — alle drei Phase-10-Migrationen angewendet, ${TABLES_EXPECTED} Tabellen, ApiKey.keyHash-Unique erzwungen, ApiIdempotency(orgId,key)-Unique org-gescopt erzwungen, WebhookEndpoint-/WebhookDelivery-Indizes vorhanden, WebhookDelivery folgt WebhookEndpoint per ON DELETE CASCADE"

echo "==> Fall 15 (Phase 11b): Layout-Spalten, footerMode-Backfill auf Bestandszeile, Organization.ownerName"
# Eigenes Bestands-Szenario (analog Fall 13): alle Migrationen bis VOR Phase 11b einspielen,
# eine BrandingSettings-Zeile MIT Freitext-Fusszeile anlegen (footerMode existiert noch
# nicht), dann per "migrate deploy" genau die beiden Phase-11b-Migrationen nachziehen und
# pruefen, dass der Backfill die Bestandszeile auf CUSTOM stellt, Zeilen OHNE Freitext auf
# AUTO bleiben und layoutId den Default "standard" traegt.
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20260907075900_phase11b_layouts|20260907090333_phase11b_footermode_backfill)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org15a','Bestand Fuenfzehn A GmbH','Weg 15','99915','Bestadt',NOW());
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org15b','Bestand Fuenfzehn B GmbH','Weg 16','99916','Bestadt',NOW());
INSERT INTO "BrandingSettings" ("id","orgId","footerLeft","updatedAt")
  VALUES ('bs15a','org15a','Alte Fusszeile links',NOW());
INSERT INTO "BrandingSettings" ("id","orgId","updatedAt")
  VALUES ('bs15b','org15b',NOW());
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Phase-11b-Migrationen sind auf der Bestands-DB fehlgeschlagen"
P11BMIG=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from _prisma_migrations where migration_name in ('20260907075900_phase11b_layouts','20260907090333_phase11b_footermode_backfill') and finished_at is not null")
[ "$P11BMIG" = "2" ] || fail "erwartet beide Phase-11b-Migrationen als angewendet, gefunden $P11BMIG"
FM_A=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"footerMode\" from \"BrandingSettings\" where id='bs15a'")
[ "$FM_A" = "CUSTOM" ] || fail "Bestandszeile bs15a mit Freitext-Fusszeile: footerMode ist '$FM_A', erwartet CUSTOM (Backfill)"
FM_B=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"footerMode\" from \"BrandingSettings\" where id='bs15b'")
[ "$FM_B" = "AUTO" ] || fail "Bestandszeile bs15b ohne Freitext: footerMode ist '$FM_B', erwartet AUTO"
LAYOUT_A=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"layoutId\" from \"BrandingSettings\" where id='bs15a'")
[ "$LAYOUT_A" = "standard" ] || fail "Bestandszeile bs15a: layoutId ist '$LAYOUT_A', erwartet Default standard"
OWNERCOL=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from information_schema.columns where table_name='Organization' and column_name='ownerName'")
[ "$OWNERCOL" = "1" ] || fail "Spalte Organization.ownerName fehlt nach Phase 11b"
COUNT15=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT15" = "$TABLES_EXPECTED" ] || fail "erwartet weiterhin ${TABLES_EXPECTED} Tabellen nach Phase 11b (nur Spalten), gefunden $COUNT15"
echo "    ok — Phase-11b-Migrationen angewendet, footerMode-Backfill CUSTOM/AUTO korrekt, layoutId-Default standard, Organization.ownerName vorhanden, ${TABLES_EXPECTED} Tabellen"

echo "==> Fall 16 (Phase 12a): giroSizeMm-Default auf Bestandszeile"
# Eigenes Bestands-Szenario (analog Fall 15): alle Migrationen bis VOR der Phase-12a-
# Migration einspielen, eine PrintSettings-Zeile im ALTEN Spaltenumfang (ohne giroSizeMm)
# anlegen, dann per "migrate deploy" genau die Phase-12a-Migration nachziehen und pruefen,
# dass ALTER TABLE ... ADD COLUMN ... DEFAULT 22 die Bestandszeile korrekt befuellt.
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20260908090100_phase12a_giro_size)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org16','Bestand Sechzehn GmbH','Weg 17','99917','Bestadt',NOW());
INSERT INTO "PrintSettings" ("id","orgId","updatedAt")
  VALUES ('ps16','org16',NOW());
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Phase-12a-Migration ist auf der Bestands-DB fehlgeschlagen"
P12AMIG=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from _prisma_migrations where migration_name='20260908090100_phase12a_giro_size' and finished_at is not null")
[ "$P12AMIG" = "1" ] || fail "Phase-12a-Migration ist nicht als angewendet verbucht"
GIRO=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"giroSizeMm\" from \"PrintSettings\" where id='ps16'")
[ "$GIRO" = "22" ] || fail "Bestandszeile ps16: giroSizeMm ist '$GIRO', erwartet Default 22"
COUNT16=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT16" = "$TABLES_EXPECTED" ] || fail "erwartet weiterhin ${TABLES_EXPECTED} Tabellen nach Phase 12a (nur eine Spalte), gefunden $COUNT16"
echo "    ok — giroSizeMm mit Default 22 auf Bestandszeile, ${TABLES_EXPECTED} Tabellen"

echo "==> Fall 17 (Phase 12b): Differenzbesteuerung — taxCategory S -> E nur bei DRAFT-Belegen"
# Eigenes Bestands-Szenario (analog Fall 16): alle Migrationen bis VOR der Phase-12b-
# Migration einspielen, eine festgeschriebene und eine im Entwurf befindliche DIFFERENZ-
# Rechnung sowie ein DIFFERENZ-Angebot im Entwurf mit taxCategory='S' anlegen, dann per
# "migrate deploy" die Phase-12b-Migration nachziehen und pruefen, dass NUR die Entwuerfe
# auf 'E' migriert werden — der festgeschriebene Beleg bleibt unveraendert (GoBD).
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20260909090100_phase12b_differenz_category)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org17','Bestand Siebzehn GmbH','Weg 18','99918','Bestadt',NOW());
INSERT INTO "Customer" ("id","orgId","name","addressLine1","postalCode","city","updatedAt")
  VALUES ('cust17','org17','Siebzehn-Kunde GmbH','Kundenweg 18','99919','Bestadt',NOW());
INSERT INTO "Invoice" ("id","orgId","customerId","status","taxScheme","updatedAt")
  VALUES ('inv17final','org17','cust17','FINALIZED','DIFFERENZ',NOW());
INSERT INTO "InvoiceLine" ("id","invoiceId","position","description","quantityMilli","unitNetPriceCents","taxRate","taxCategory","lineNetCents")
  VALUES ('il17final','inv17final',1,'Gebrauchtwagen',1000,500000,0,'S',500000);
INSERT INTO "Invoice" ("id","orgId","customerId","status","taxScheme","updatedAt")
  VALUES ('inv17draft','org17','cust17','DRAFT','DIFFERENZ',NOW());
INSERT INTO "InvoiceLine" ("id","invoiceId","position","description","quantityMilli","unitNetPriceCents","taxRate","taxCategory","lineNetCents")
  VALUES ('il17draft','inv17draft',1,'Gebrauchtwagen',1000,500000,0,'S',500000);
INSERT INTO "Quote" ("id","orgId","customerId","status","taxScheme","updatedAt")
  VALUES ('quo17draft','org17','cust17','DRAFT','DIFFERENZ',NOW());
INSERT INTO "QuoteLine" ("id","quoteId","position","description","quantityMilli","unitNetPriceCents","taxRate","taxCategory","lineNetCents")
  VALUES ('ql17','quo17draft',1,'Gebrauchtwagen',1000,500000,0,'S',500000);
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Phase-12b-Migration ist auf der Bestands-DB fehlgeschlagen"
P12BMIG=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from _prisma_migrations where migration_name='20260909090100_phase12b_differenz_category' and finished_at is not null")
[ "$P12BMIG" = "1" ] || fail "Phase-12b-Migration ist nicht als angewendet verbucht"
DRAFTCAT=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"taxCategory\" from \"InvoiceLine\" where id='il17draft'")
[ "$DRAFTCAT" = "E" ] || fail "Entwurfszeile il17draft: taxCategory ist '$DRAFTCAT', erwartet E"
FINALCAT=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"taxCategory\" from \"InvoiceLine\" where id='il17final'")
[ "$FINALCAT" = "S" ] || fail "festgeschriebene Zeile il17final wurde veraendert ('$FINALCAT') — GoBD-Verstoss"
QUOTECAT=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"taxCategory\" from \"QuoteLine\" where id='ql17'")
[ "$QUOTECAT" = "E" ] || fail "Angebotszeile ql17: taxCategory ist '$QUOTECAT', erwartet E"
echo "    ok — DIFFERENZ-Entwuerfe auf E migriert, festgeschriebene Belege unveraendert"

echo "==> Fall 18 (Phase 12c): Marken-Spalten NULL auf Bestandszeile"
# Eigenes Bestands-Szenario (analog Fall 16): alle Migrationen bis VOR der Phase-12c-
# Migration einspielen, eine BrandingSettings-Zeile im ALTEN Spaltenumfang (ohne die vier
# Marken-Spalten) anlegen, dann per "migrate deploy" genau die Phase-12c-Migration
# nachziehen und pruefen, dass die neuen Spalten NULL-bar sind und die Bestandszeile NULL
# traegt (Produktvorgabe, keine Datenmigration noetig).
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20260910090100_phase12c_branding_marke)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org18','Bestand Achtzehn GmbH','Weg 19','99920','Bestadt',NOW());
INSERT INTO "BrandingSettings" ("id","orgId","updatedAt")
  VALUES ('bs18','org18',NOW());
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Phase-12c-Migration ist auf der Bestands-DB fehlgeschlagen"
P12CMIG=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from _prisma_migrations where migration_name='20260910090100_phase12c_branding_marke' and finished_at is not null")
[ "$P12CMIG" = "1" ] || fail "Phase-12c-Migration ist nicht als angewendet verbucht"
APPNAME=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select coalesce(\"appName\",'<null>') from \"BrandingSettings\" where id='bs18'")
[ "$APPNAME" = "<null>" ] || fail "Bestandszeile bs18: appName ist '$APPNAME', erwartet NULL"
MARKECOLS=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from information_schema.columns where table_name='BrandingSettings' and column_name in ('appName','appShortName','faviconPath','appLogoPath')")
[ "$MARKECOLS" = "4" ] || fail "erwartet 4 Marken-Spalten auf BrandingSettings, gefunden $MARKECOLS"
COUNT18=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT18" = "$TABLES_EXPECTED" ] || fail "erwartet weiterhin ${TABLES_EXPECTED} Tabellen nach Phase 12c/Marke (nur Spalten), gefunden $COUNT18"
echo "    ok — vier Marken-Spalten NULL-bar, Bestandszeile unveraendert, ${TABLES_EXPECTED} Tabellen"

echo "==> Fall 19 (Phase 12c): DocumentSettings.taxRatesJson-Default fuer Bestandszeile"
# Eigenes Bestands-Szenario (analog Fall 18): alle Migrationen bis VOR der Phase-12c-
# Steuersatz-Migration einspielen, eine DocumentSettings-Zeile im ALTEN Spaltenumfang
# (ohne taxRatesJson) anlegen, dann per "migrate deploy" genau diese Migration nachziehen
# und pruefen, dass die Bestandszeile den Default [19,7,0] traegt (bisher fest verdrahtete
# Liste, jetzt org-eigene Spalte — keine Datenmigration noetig).
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20260910091100_phase12c_tax_rates)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org19','Bestand Neunzehn GmbH','Weg 20','99921','Bestadt',NOW());
INSERT INTO "DocumentSettings" ("id","orgId","onQuoteAccept","shareLinkDays","storeAcceptIp","updatedAt")
  VALUES ('ds19','org19','NONE',30,false,NOW());
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Phase-12c-Steuersatz-Migration ist auf der Bestands-DB fehlgeschlagen"
P12CTAXMIG=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from _prisma_migrations where migration_name='20260910091100_phase12c_tax_rates' and finished_at is not null")
[ "$P12CTAXMIG" = "1" ] || fail "Phase-12c-Steuersatz-Migration ist nicht als angewendet verbucht"
TAXJSON=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"taxRatesJson\" from \"DocumentSettings\" where id='ds19'")
[ "$TAXJSON" = "[19,7,0]" ] || fail "Bestandszeile ds19: taxRatesJson ist '$TAXJSON', erwartet Default [19,7,0]"
COUNT19=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT19" = "$TABLES_EXPECTED" ] || fail "erwartet weiterhin ${TABLES_EXPECTED} Tabellen nach Phase 12c/Steuersaetze, gefunden $COUNT19"
echo "    ok — taxRatesJson mit Default [19,7,0] auf Bestandszeile, ${TABLES_EXPECTED} Tabellen"

echo "==> Fall 20 (Phase 12d): Anfrageprotokoll — zwei neue Tabellen, Indizes, Defaults"
# Eigenes Bestands-Szenario (analog Fall 16/18): alle Migrationen bis VOR der Phase-12d-
# Migration einspielen, org20 anlegen, dann per "migrate deploy" genau die Phase-12d-
# Migration nachziehen und pruefen, dass ApiRequestLog/ApiSettings mit ihren vier Indizes
# angelegt werden und eine neu erzeugte ApiSettings-Zeile die Protokoll-AUS-Defaults traegt.
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20260911090100_phase12d_api_log)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org20','Bestand Zwanzig GmbH','Weg 21','99922','Bestadt',NOW());
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Phase-12d-Migration ist auf der Bestands-DB fehlgeschlagen"
P12DMIG=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from _prisma_migrations where migration_name='20260911090100_phase12d_api_log' and finished_at is not null")
[ "$P12DMIG" = "1" ] || fail "Phase-12d-Migration ist nicht als angewendet verbucht"
for TBL in ApiRequestLog ApiSettings; do
  EXISTS=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select to_regclass('\"$TBL\"') is not null")
  [ "$EXISTS" = "t" ] || fail "Tabelle $TBL fehlt nach der Phase-12d-Migration"
done
for IDX in ApiRequestLog_orgId_createdAt_idx ApiRequestLog_orgId_status_createdAt_idx ApiRequestLog_createdAt_idx ApiSettings_orgId_key; do
  N=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from pg_indexes where indexname='$IDX'")
  [ "$N" = "1" ] || fail "Index $IDX fehlt"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "ApiSettings" ("id","orgId","updatedAt") VALUES ('as20','org20',NOW());
SQL
DEFAULTS=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select \"logRequests\",\"logBodies\",\"retentionDays\",\"maxRows\" from \"ApiSettings\" where id='as20'")
[ "$DEFAULTS" = "f|f|7|2000" ] || fail "ApiSettings-Defaults abweichend ('$DEFAULTS'), erwartet f|f|7|2000"
COUNT20=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT20" = "$TABLES_EXPECTED" ] || fail "erwartet ${TABLES_EXPECTED} Tabellen nach Phase 12d, gefunden $COUNT20"
echo "    ok — ApiRequestLog + ApiSettings mit vier Indizes, Protokoll standardmaessig AUS, ${TABLES_EXPECTED} Tabellen"

echo "==> Fall 21 (fix/einheiten-kontoinhaber): Organization.accountHolder"
# Eigenes Bestands-Szenario (analog Fall 15, ownerName): alle Migrationen bis VOR der
# Kontoinhaber-Migration einspielen, eine Bestandszeile im ALTEN Spaltenumfang anlegen,
# dann per "migrate deploy" genau diese Migration nachziehen und pruefen, dass die neue
# Spalte existiert (NULL auf der Bestandszeile, kein Default/Backfill noetig) und die
# Tabellenzahl unveraendert bleibt (reine Spalte, keine neue Tabelle).
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20260912090100_account_holder)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org21','Bestand Einundzwanzig GmbH','Weg 22','99921','Bestadt',NOW());
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Kontoinhaber-Migration ist auf der Bestands-DB fehlgeschlagen"
ACCMIG=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from _prisma_migrations where migration_name='20260912090100_account_holder' and finished_at is not null")
[ "$ACCMIG" = "1" ] || fail "Kontoinhaber-Migration ist nicht als angewendet verbucht"
ACCCOL=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from information_schema.columns where table_name='Organization' and column_name='accountHolder'")
[ "$ACCCOL" = "1" ] || fail "Spalte Organization.accountHolder fehlt nach der Migration"
ACCVAL=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select coalesce(\"accountHolder\",'<null>') from \"Organization\" where id='org21'")
[ "$ACCVAL" = "<null>" ] || fail "Bestandszeile org21: accountHolder ist '$ACCVAL', erwartet NULL (kein Backfill)"
COUNT21=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT21" = "$TABLES_EXPECTED" ] || fail "erwartet weiterhin ${TABLES_EXPECTED} Tabellen nach der Kontoinhaber-Migration (nur eine Spalte), gefunden $COUNT21"
echo "    ok — Organization.accountHolder vorhanden, NULL auf Bestandszeile, ${TABLES_EXPECTED} Tabellen"

echo "==> Fall 22 (Phase 13d): Belegvorlagen — Tabelle, Unique auf (orgId,name), Default usageCount"
# Praeambel woertlich wie Fall 21, Ausschluss '20260913090100_phase13d_templates', Bestandszeile org22.
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20260913090100_phase13d_templates)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org22','Bestand Zweiundzwanzig GmbH','Weg 23','99923','Bestadt',NOW());
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Vorlagen-Migration ist auf der Bestands-DB fehlgeschlagen"
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "DocumentTemplate" ("id","orgId","name","docType","payloadJson","updatedAt")
  VALUES ('tpl22','org22','Wartung monatlich','INVOICE','{"lines":[]}',NOW());
SQL
USAGE=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"usageCount\", coalesce(\"lastUsedAt\"::text,'<null>') from \"DocumentTemplate\" where id='tpl22'")
[ "$USAGE" = "0|<null>" ] || fail "DocumentTemplate-Defaults abweichend ('$USAGE'), erwartet 0|<null>"
DUP=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "insert into \"DocumentTemplate\" (\"id\",\"orgId\",\"name\",\"docType\",\"payloadJson\",\"updatedAt\") values ('tpl22b','org22','Wartung monatlich','QUOTE','{}',NOW())" 2>&1 || true)
echo "$DUP" | grep -q "duplicate key" || fail "Unique (orgId,name) auf DocumentTemplate greift nicht"
COUNT22=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT22" = "$TABLES_EXPECTED" ] || fail "erwartet ${TABLES_EXPECTED} Tabellen nach Phase 13d/Vorlagen, gefunden $COUNT22"
echo "    ok — DocumentTemplate mit Unique (orgId,name) und usageCount-Default 0, ${TABLES_EXPECTED} Tabellen"

echo "==> Fall 23 (Phase 13d): Tags — Doppelzuordnung verboten, Cascade beim Tag-Loeschen"
# Praeambel woertlich wie Fall 21, Ausschluss '20260913092100_phase13d_tags', Bestandszeile org23.
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20260913092100_phase13d_tags)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org23','Bestand Dreiundzwanzig GmbH','Weg 24','99924','Bestadt',NOW());
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Tags-Migration ist auf der Bestands-DB fehlgeschlagen"
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Tag" ("id","orgId","name","updatedAt") VALUES ('tag23','org23','Wartung',NOW());
INSERT INTO "DocumentTag" ("id","orgId","tagId","docType","docId") VALUES ('dt23','org23','tag23','INVOICE','inv23');
SQL
[ "$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select color from \"Tag\" where id='tag23'")" = "slate" ] || fail "Tag.color-Default ist nicht slate"
DUP2=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "insert into \"DocumentTag\" (\"id\",\"orgId\",\"tagId\",\"docType\",\"docId\") values ('dt23b','org23','tag23','INVOICE','inv23')" 2>&1 || true)
echo "$DUP2" | grep -q "duplicate key" || fail "Unique (orgId,tagId,docType,docId) greift nicht — Doppelzuordnung moeglich"
docker exec "$CONTAINER" psql -U oig -d openinvoice -q -c "DELETE FROM \"Tag\" WHERE id='tag23'" >/dev/null
LEFT=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from \"DocumentTag\" where \"tagId\"='tag23'")
[ "$LEFT" = "0" ] || fail "Cascade fehlt: nach dem Tag-Loeschen bleiben $LEFT Zuordnungen"
COUNT23=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT23" = "$TABLES_EXPECTED" ] || fail "erwartet ${TABLES_EXPECTED} Tabellen nach Phase 13d/Tags, gefunden $COUNT23"
echo "    ok — Tag/DocumentTag mit Unique und ON DELETE CASCADE, ${TABLES_EXPECTED} Tabellen"

echo "==> Fall 24 (Phase 14a): Basiszins-Halbjahrestabelle — Backfill aus DunningSettings, Unique (orgId,validFrom); Dunning.interestSegmentsJson bleibt bei Bestandszeilen NULL"
# Praeambel woertlich wie Fall 21, Ausschluss der beiden Phase-14a-Mahnwesen-Migrationen
# (Basiszins-Backfill UND die additive Dunning-Spalte aus Task 3) — Bestandszeilen org24.
# Hotfix (fix/pdf-zeilenhoehe-und-quelle, A9): die spaetere Migration
# 20260914093100_hotfix_base_rate_source_text aendert per UPDATE ausschliesslich
# BaseInterestRate.source — hier ebenfalls ausklammern, sonst P1014 (Tabelle existiert an
# dieser Stelle absichtlich noch nicht), der anschliessende "migrate deploy" zieht sie nach
# der Basiszins-Migration in der richtigen Reihenfolge nach.
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20260914090100_phase14a_base_interest_rate|20260914091100_phase14a_dunning_segments|20260914093100_hotfix_base_rate_source_text)$' | sort); do
  apply_and_mark "$MIG"
done
# Bestands-DunningSettings mit 188 bp und OHNE baseRateValidFrom (NULL) — die Migration
# muss dafuer genau einen BaseInterestRate-Eintrag mit validFrom=1970-01-01 anlegen
# (COALESCE-Fallback, keine Zinsluecke fuer Bestandsorganisationen ohne gesetztes Datum).
# Zusaetzlich eine Bestands-Mahnung (Kunde/Rechnung/Dunning) VOR der additiven
# interestSegmentsJson-Spalte anlegen (Task 3) — muss danach unveraendert NULL bleiben.
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org24','Bestand Vierundzwanzig GmbH','Weg 25','99925','Bestadt',NOW());
INSERT INTO "DunningSettings" ("id","orgId","baseInterestRateBp","updatedAt")
  VALUES ('dset24','org24',188,NOW());
INSERT INTO "Customer" ("id","orgId","name","addressLine1","postalCode","city","updatedAt")
  VALUES ('cust24','org24','Bestand Vierundzwanzig Kunde AG','Weg 26','99926','Bestadt',NOW());
INSERT INTO "Invoice" ("id","orgId","customerId","number","status","updatedAt")
  VALUES ('inv24','org24','cust24','RE-2026-00024','FINALIZED',NOW());
INSERT INTO "Dunning" ("id","invoiceId","level") VALUES ('dun24','inv24',1);
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Basiszins-/Dunning-Segmente-Migration ist auf der Bestands-DB fehlgeschlagen"
BIRCOUNT=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from \"BaseInterestRate\" where \"orgId\"='org24'")
[ "$BIRCOUNT" = "1" ] || fail "erwartet genau einen BaseInterestRate-Eintrag fuer org24 (Backfill), gefunden $BIRCOUNT"
BIRVAL=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"rateBp\", to_char(\"validFrom\",'YYYY-MM-DD') from \"BaseInterestRate\" where \"orgId\"='org24'")
[ "$BIRVAL" = "188|1970-01-01" ] || fail "Basiszins-Backfill abweichend ('$BIRVAL'), erwartet 188|1970-01-01"
# Hotfix (A9): 20260914093100_hotfix_base_rate_source_text lief soeben als Teil desselben
# "migrate deploy" (nach der Basiszins-Migration, siehe Ausschlussliste oben) — org24s
# Backfill-Zeile traegt den ANDEREN Text "Migration Phase 14a" (nicht den vom Hotfix
# anvisierten Platzhalter "Selbstheilung Phase 14a") und muss deshalb unveraendert bleiben.
BIRSRC=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"source\" from \"BaseInterestRate\" where \"orgId\"='org24'")
[ "$BIRSRC" = "Migration Phase 14a" ] || fail "Hotfix-Migration hat eine NICHT betroffene BaseInterestRate.source-Zeile veraendert ('$BIRSRC')"
DUP3=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "insert into \"BaseInterestRate\" (\"id\",\"orgId\",\"validFrom\",\"rateBp\",\"updatedAt\") values ('bir24b','org24','1970-01-01',150,NOW())" 2>&1 || true)
echo "$DUP3" | grep -q "duplicate key" || fail "Unique (orgId, validFrom) auf BaseInterestRate greift nicht"
DUNSEG=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"interestSegmentsJson\" from \"Dunning\" where id='dun24'")
[ -z "$DUNSEG" ] || fail "erwartet NULL interestSegmentsJson fuer Bestands-Dunning dun24, gefunden '$DUNSEG'"
COUNT24=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT24" = "$TABLES_EXPECTED" ] || fail "erwartet ${TABLES_EXPECTED} Tabellen nach Phase 14a/Basiszins+Dunning-Segmente, gefunden $COUNT24"
echo "    ok — BaseInterestRate-Backfill (188 bp, 1970-01-01) aus Bestands-DunningSettings, Unique (orgId,validFrom) erzwungen, Bestands-Dunning behaelt NULL interestSegmentsJson, ${TABLES_EXPECTED} Tabellen, Hotfix-Quellenfeld-Migration liess nicht betroffene Zeile unveraendert"

echo "==> Fall 25 (Phase 14a, Task 8): Anmeldung haerten — additive User-Spalten, Bestandszeile bleibt lauffaehig"
# Praeambel woertlich wie Fall 21, Ausschluss der Login-Haertung-Migration, Bestandszeile
# user25 im ALTEN Spaltenumfang (id, email, passwordHash, createdAt) — die Migration darf
# nur Spalten hinzufuegen, keine Bestandszeile veraendern/entfernen.
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20260914092100_phase14a_login_hardening)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "User" ("id","email","passwordHash","createdAt") VALUES ('user25','bestand25@example.com','x:y',NOW());
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Login-Haertung-Migration ist auf der Bestands-DB fehlgeschlagen"
USERVAL=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"failedLoginCount\", coalesce(\"lockedUntil\"::text,'<null>'), coalesce(\"lastLoginAt\"::text,'<null>'), coalesce(\"passwordChangedAt\"::text,'<null>') from \"User\" where id='user25'")
[ "$USERVAL" = "0|<null>|<null>|<null>" ] || fail "User-Bestandszeile user25 abweichend ('$USERVAL'), erwartet 0|<null>|<null>|<null>"
COUNT25=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT25" = "$TABLES_EXPECTED" ] || fail "erwartet weiterhin ${TABLES_EXPECTED} Tabellen nach der Login-Haertung-Migration (nur vier Spalten), gefunden $COUNT25"
echo "    ok — User.failedLoginCount=0, lockedUntil/lastLoginAt/passwordChangedAt NULL auf Bestandszeile, ${TABLES_EXPECTED} Tabellen"

echo "==> Fall 26 (Phase 16a, Task 1): Gegenbuchung/Belegarchiv/Kettenpruefung — additive Payment-Spalten, drei neue Tabellen"
# Praeambel woertlich wie Fall 21, Ausschluss der Phase-16a-Migration, Bestandszeile
# Payment (pay26) im ALTEN Spaltenumfang — die Migration darf nur Spalten/Tabellen
# hinzufuegen; Bestandszeilen erhalten die Defaults (kind=PAYMENT, createdBy=user).
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20261111090100_phase16a_gobd_betrieb|20261112090100_phase16b_ausland|20261113090100_phase16e_oss|20261114090100_phase16g_layout|20261115090100_phase17a_erechnung|20261116090100_phase17d_auth|20261117090100_phase16d_postal|20261118090100_phase18c_belegfluss|20261119090100_phase18e_payment_means|20261119100100_phase18d_api_indexes|20261120090100_phase18f_usage|20261121090100_kundenportal|20261122090100_bankabgleich|20261123090100_sammelrechnung|20261124090100_zahlungsaktionen|20261125090100_zahlungsanbieter|20261126090100_stripe|20261127090100_datev|20261128090100_pflichtpruefungen|20261129090100_eingangsrechnungen|20261130090100_eingang_ablauf)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org26','Bestand Sechsundzwanzig GmbH','Weg 27','99927','Bestadt',NOW());
INSERT INTO "Customer" ("id","orgId","name","addressLine1","postalCode","city","updatedAt")
  VALUES ('cust26','org26','Bestand Sechsundzwanzig Kunde AG','Weg 28','99928','Bestadt',NOW());
INSERT INTO "Invoice" ("id","orgId","customerId","number","status","updatedAt")
  VALUES ('inv26','org26','cust26','RE-2026-00026','FINALIZED',NOW());
INSERT INTO "Payment" ("id","invoiceId","amountCents","method") VALUES ('pay26','inv26',100,'TRANSFER');
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Phase-16a-Migration ist auf der Bestands-DB fehlgeschlagen"
PAYVAL=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"kind\", \"createdBy\", coalesce(\"provider\",'<null>'), coalesce(\"providerPaymentId\",'<null>'), coalesce(\"reversesPaymentId\",'<null>') from \"Payment\" where id='pay26'")
[ "$PAYVAL" = "PAYMENT|user|<null>|<null>|<null>" ] || fail "Payment-Bestandszeile pay26 abweichend ('$PAYVAL'), erwartet PAYMENT|user|<null>|<null>|<null>"
# Unique (provider, providerPaymentId): mehrere NULL/NULL-Zeilen erlaubt, doppelte Anbieter-Referenz nicht.
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Payment" ("id","invoiceId","amountCents","method") VALUES ('pay26b','inv26',200,'TRANSFER');
INSERT INTO "Payment" ("id","invoiceId","amountCents","method") VALUES ('pay26c','inv26',300,'TRANSFER');
INSERT INTO "Payment" ("id","invoiceId","amountCents","method","provider","providerPaymentId") VALUES ('pay26d','inv26',400,'CARD','PSP_A','tr_1');
SQL
DUPPAY=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "insert into \"Payment\" (\"id\",\"invoiceId\",\"amountCents\",\"method\",\"provider\",\"providerPaymentId\") values ('pay26e','inv26',400,'CARD','PSP_A','tr_1')" 2>&1 || true)
echo "$DUPPAY" | grep -q "duplicate key" || fail "Unique (provider, providerPaymentId) auf Payment greift nicht"
for TBL in ChainVerification ArchivedDocument SystemMarker; do
  EXISTS=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select to_regclass('\"$TBL\"') is not null")
  [ "$EXISTS" = "t" ] || fail "Tabelle $TBL fehlt nach der Phase-16a-Migration"
done
EPOCH=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from \"SystemMarker\" where \"key\"='archive-epoch'")
[ "$EPOCH" = "1" ] || fail "SystemMarker archive-epoch fehlt nach der Phase-16a-Migration"
COUNT26=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT26" = "$TABLES_EXPECTED" ] || fail "erwartet ${TABLES_EXPECTED} Tabellen nach Phase 16a, gefunden $COUNT26"
echo "    ok — Payment.kind=PAYMENT/createdBy=user auf Bestandszeile, Unique (provider,providerPaymentId) erzwungen (NULL/NULL mehrfach erlaubt), ChainVerification/ArchivedDocument/SystemMarker vorhanden, archive-epoch gesetzt, ${TABLES_EXPECTED} Tabellen"

echo "==> Fall 27 (Phase 16b, Task 1): Ausland — ExchangeRate, Kurs-/EUR-Felder am Beleg, Belegsprache, Vorlagen-Eindeutigkeit je Sprache"
# Praeambel woertlich wie Fall 26, Ausschluss der Phase-16b-Migration (Fall 26 wendet
# 16a bereits an). Bestand im ALTEN Spaltenumfang: eine FINALIZED-EUR-Rechnung, eine
# FINALIZED-USD-Rechnung, eine EmailTemplate (org, INVOICE, 'Standard').
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20261112090100_phase16b_ausland|20261113090100_phase16e_oss|20261114090100_phase16g_layout|20261115090100_phase17a_erechnung|20261116090100_phase17d_auth|20261117090100_phase16d_postal|20261118090100_phase18c_belegfluss|20261119090100_phase18e_payment_means|20261119100100_phase18d_api_indexes|20261120090100_phase18f_usage|20261121090100_kundenportal|20261122090100_bankabgleich|20261123090100_sammelrechnung|20261124090100_zahlungsaktionen|20261125090100_zahlungsanbieter|20261126090100_stripe|20261127090100_datev|20261128090100_pflichtpruefungen|20261129090100_eingangsrechnungen|20261130090100_eingang_ablauf)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org27','Bestand Siebenundzwanzig GmbH','Weg 29','99929','Bestadt',NOW());
INSERT INTO "Customer" ("id","orgId","name","addressLine1","postalCode","city","updatedAt")
  VALUES ('cust27','org27','Bestand Siebenundzwanzig Kunde AG','Weg 30','99930','Bestadt',NOW());
INSERT INTO "Invoice" ("id","orgId","customerId","number","status","currency","netTotalCents","taxTotalCents","grossTotalCents","updatedAt")
  VALUES ('inv27eur','org27','cust27','RE-2027-00001','FINALIZED','EUR',10000,1900,11900,NOW());
INSERT INTO "Invoice" ("id","orgId","customerId","number","status","currency","netTotalCents","taxTotalCents","grossTotalCents","updatedAt")
  VALUES ('inv27usd','org27','cust27','RE-2027-00002','FINALIZED','USD',10000,1900,11900,NOW());
INSERT INTO "EmailTemplate" ("id","orgId","name","docType","subject","body","updatedAt")
  VALUES ('et27','org27','Standard','INVOICE','Betreff','Text',NOW());
INSERT INTO "TextTemplate" ("id","orgId","name","docType","position","body","updatedAt")
  VALUES ('tt27','org27','Standard','INVOICE','HEAD','Kopf',NOW());
INSERT INTO "Quote" ("id","orgId","customerId","status","updatedAt") VALUES ('q27','org27','cust27','DRAFT',NOW());
INSERT INTO "DeliveryNote" ("id","orgId","customerId","status","updatedAt") VALUES ('dn27','org27','cust27','DRAFT',NOW());
INSERT INTO "Dunning" ("id","invoiceId","level") VALUES ('dun27','inv27eur',1);
INSERT INTO "RecurringInvoice" ("id","orgId","customerId","title","startDate","nextRunDate","updatedAt")
  VALUES ('rec27','org27','cust27','Abo','2026-01-01','2026-02-01',NOW());
INSERT INTO "DocumentSettings" ("id","orgId","onQuoteAccept","shareLinkDays","storeAcceptIp","updatedAt")
  VALUES ('ds27','org27','NONE',30,false,NOW());
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Phase-16b-Migration ist auf der Bestands-DB fehlgeschlagen"
EURVAL=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select coalesce(\"taxTotalEurCents\"::text,'<null>'), coalesce(\"netTotalEurCents\"::text,'<null>'), \"language\" from \"Invoice\" where id='inv27eur'")
[ "$EURVAL" = "1900|10000|de" ] || fail "EUR-Rechnung abweichend ('$EURVAL'), erwartet 1900|10000|de"
USDVAL=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select coalesce(\"taxTotalEurCents\"::text,'<null>'), coalesce(\"netTotalEurCents\"::text,'<null>'), \"language\" from \"Invoice\" where id='inv27usd'")
[ "$USDVAL" = "<null>|<null>|de" ] || fail "USD-Rechnung abweichend ('$USDVAL'), erwartet <null>|<null>|de"
ETLANG=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"language\" from \"EmailTemplate\" where id='et27'")
[ "$ETLANG" = "de" ] || fail "EmailTemplate.language abweichend ('$ETLANG'), erwartet de"
for ROW in "Quote:q27" "DeliveryNote:dn27" "Dunning:dun27" "RecurringInvoice:rec27" "TextTemplate:tt27"; do
  TBL="${ROW%%:*}"; RID="${ROW##*:}"
  LANGV=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"language\" from \"$TBL\" where id='$RID'")
  [ "$LANGV" = "de" ] || fail "$TBL.language abweichend ('$LANGV'), erwartet de"
done
FXDEF=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"fxRateSource\" from \"DocumentSettings\" where id='ds27'")
[ "$FXDEF" = "BMF_MONTHLY" ] || fail "DocumentSettings.fxRateSource-Default abweichend ('$FXDEF'), erwartet BMF_MONTHLY"
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "EmailTemplate" ("id","orgId","name","docType","subject","body","language","updatedAt")
  VALUES ('et27en','org27','Standard','INVOICE','Subject','Text','en',NOW());
SQL
DUPET=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "insert into \"EmailTemplate\" (\"id\",\"orgId\",\"name\",\"docType\",\"subject\",\"body\",\"language\",\"updatedAt\") values ('et27dup','org27','Standard','INVOICE','X','Y','de',NOW())" 2>&1 || true)
echo "$DUPET" | grep -q "duplicate key" || fail "Unique (orgId, docType, language, name) auf EmailTemplate greift nicht"
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "TextTemplate" ("id","orgId","name","docType","position","body","language","updatedAt")
  VALUES ('tt27en','org27','Standard','INVOICE','HEAD','Dear','en',NOW());
SQL
DUPTT=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "insert into \"TextTemplate\" (\"id\",\"orgId\",\"name\",\"docType\",\"position\",\"body\",\"language\",\"updatedAt\") values ('tt27dup','org27','Standard','INVOICE','HEAD','X','de',NOW())" 2>&1 || true)
echo "$DUPTT" | grep -q "duplicate key" || fail "Unique (orgId, docType, position, language, name) auf TextTemplate greift nicht"
OLDIDX=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from pg_indexes where indexname in ('EmailTemplate_orgId_docType_name_key','TextTemplate_orgId_docType_position_name_key')")
[ "$OLDIDX" = "0" ] || fail "alte Vorlagen-Indizes noch vorhanden"
EXISTS=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select to_regclass('\"ExchangeRate\"') is not null")
[ "$EXISTS" = "t" ] || fail "Tabelle ExchangeRate fehlt nach der Phase-16b-Migration"
FXSRC=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from information_schema.columns where table_name='DocumentSettings' and column_name='fxRateSource'")
[ "$FXSRC" = "1" ] || fail "DocumentSettings.fxRateSource fehlt"
COUNT27=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT27" = "$TABLES_EXPECTED" ] || fail "erwartet ${TABLES_EXPECTED} Tabellen nach Phase 16b, gefunden $COUNT27"
echo "    ok — EUR-Rechnung 1900/10000, USD-Rechnung NULL, language=de ueberall, de+en je Vorlagenname moeglich, zweites de scheitert, ${TABLES_EXPECTED} Tabellen"

echo "==> Fall 28 (Phase 16e, Task 1): OSS-Schwelle — Zaehlmodus, Warnschwelle, Produkt-, Positions-, Angebots- und Abo-Positionskategorie"
# Praeambel woertlich wie Fall 27, Ausschluss nur der Phase-16e-Migration. Bestand im
# ALTEN Spaltenumfang: Einstellungen, Produkt, festgeschriebene Rechnung mit einer Position.
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20261113090100_phase16e_oss|20261114090100_phase16g_layout|20261115090100_phase17a_erechnung|20261116090100_phase17d_auth|20261117090100_phase16d_postal|20261118090100_phase18c_belegfluss|20261119090100_phase18e_payment_means|20261119100100_phase18d_api_indexes|20261120090100_phase18f_usage|20261121090100_kundenportal|20261122090100_bankabgleich|20261123090100_sammelrechnung|20261124090100_zahlungsaktionen|20261125090100_zahlungsanbieter|20261126090100_stripe|20261127090100_datev|20261128090100_pflichtpruefungen|20261129090100_eingangsrechnungen|20261130090100_eingang_ablauf)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org28','Bestand Achtundzwanzig GmbH','Weg 31','99931','Bestadt',NOW());
INSERT INTO "Customer" ("id","orgId","name","addressLine1","postalCode","city","updatedAt")
  VALUES ('cust28','org28','Bestand Achtundzwanzig Kunde AG','Weg 32','99932','Bestadt',NOW());
INSERT INTO "DocumentSettings" ("id","orgId","onQuoteAccept","shareLinkDays","storeAcceptIp","updatedAt")
  VALUES ('ds28','org28','NONE',30,false,NOW());
INSERT INTO "Product" ("id","orgId","name","netPriceCents","updatedAt")
  VALUES ('prod28','org28','Bestandsprodukt',1000,NOW());
INSERT INTO "Invoice" ("id","orgId","customerId","number","status","updatedAt")
  VALUES ('inv28','org28','cust28','RE-2028-00001','FINALIZED',NOW());
INSERT INTO "InvoiceLine" ("id","invoiceId","position","description","quantityMilli","unitNetPriceCents","taxRate","lineNetCents")
  VALUES ('line28','inv28',1,'Bestandsposition',1000,1000,19,1000);
INSERT INTO "Quote" ("id","orgId","customerId","updatedAt")
  VALUES ('quo28','org28','cust28',NOW());
INSERT INTO "QuoteLine" ("id","quoteId","position","description","quantityMilli","unitNetPriceCents","taxRate","lineNetCents")
  VALUES ('qline28','quo28',1,'Angebotsposition',1000,1000,19,1000);
INSERT INTO "RecurringInvoice" ("id","orgId","customerId","title","startDate","nextRunDate","updatedAt")
  VALUES ('rec28','org28','cust28','Abo28',NOW(),NOW(),NOW());
INSERT INTO "RecurringInvoiceLine" ("id","recurringInvoiceId","position","description","quantityMilli","unitNetPriceCents","taxRate")
  VALUES ('rline28','rec28',1,'Abopos',1000,1000,19);
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org28b','Bestand Achtundzwanzig B GmbH','Weg 33','99933','Bestadt',NOW());
INSERT INTO "NotificationSettings" ("id","orgId","enabledTypesJson","updatedAt")
  VALUES ('ns28','org28','["INVOICE_OVERDUE","QUOTE_EXPIRING"]',NOW()),
         ('ns28b','org28b','[]',NOW());
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Phase-16e-Migration ist auf der Bestands-DB fehlgeschlagen"
DSVAL=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"ossCountMode\" || '|' || \"ossWarnPercent\" from \"DocumentSettings\" where id='ds28'")
[ "$DSVAL" = "ALL_EU_B2C|80" ] || fail "DocumentSettings-Bestandszeile abweichend ('$DSVAL'), erwartet ALL_EU_B2C|80"
PRODVAL=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"ossCategory\" from \"Product\" where id='prod28'")
[ "$PRODVAL" = "NONE" ] || fail "Product.ossCategory abweichend ('$PRODVAL'), erwartet NONE"
LINEVAL=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select coalesce(\"ossCategory\",'<null>') from \"InvoiceLine\" where id='line28'")
[ "$LINEVAL" = "<null>" ] || fail "InvoiceLine.ossCategory abweichend ('$LINEVAL'), erwartet <null>"
SRCVAL=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select coalesce(q.\"ossCategory\",'<null>') || '|' || coalesce(r.\"ossCategory\",'<null>') from \"QuoteLine\" q, \"RecurringInvoiceLine\" r where q.id='qline28' and r.id='rline28'")
[ "$SRCVAL" = "<null>|<null>" ] || fail "QuoteLine/RecurringInvoiceLine.ossCategory abweichend ('$SRCVAL'), erwartet <null>|<null>"
NSVAL=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select string_agg(\"enabledTypesJson\", ' ' order by id) from \"NotificationSettings\" where id in ('ns28','ns28b')")
# Fall 28 laeuft am Ende mit ALLEN Migrationen: spaetere Migrationen ergaenzen weitere Typen.
[ "$NSVAL" = '["INVOICE_OVERDUE","QUOTE_EXPIRING","OSS_THRESHOLD","POSTAL_FAILED","POSTAL_PENDING","DUNNING_NOT_SENT","PAYMENT_RULE","PAYMENT_RULE_FAILED","ONLINE_OVERPAYMENT","ONLINE_PAYMENT_ISSUE","DATEV_LATE_ITEMS","KU_THRESHOLD","INCOMING_DUE"] ["OSS_THRESHOLD","POSTAL_FAILED","POSTAL_PENDING","DUNNING_NOT_SENT","PAYMENT_RULE","PAYMENT_RULE_FAILED","ONLINE_OVERPAYMENT","ONLINE_PAYMENT_ISSUE","DATEV_LATE_ITEMS","KU_THRESHOLD","INCOMING_DUE"]' ] || fail "NotificationSettings.enabledTypesJson ohne OSS_THRESHOLD/Postversand-/Zahlungsregel-/Online-Zahlungs-/DATEV-/Umsatzgrenzen-Typen ergaenzt ('$NSVAL')"
COUNT28=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT28" = "$TABLES_EXPECTED" ] || fail "erwartet weiterhin ${TABLES_EXPECTED} Tabellen nach Phase 16e (nur sechs Spalten), gefunden $COUNT28"
echo "    ok — DocumentSettings ALL_EU_B2C/80, Product.ossCategory=NONE, InvoiceLine.ossCategory NULL auf Bestandszeilen, OSS_THRESHOLD in NotificationSettings ergaenzt, ${TABLES_EXPECTED} Tabellen"

echo "==> Fall 29 (Phase 16g, Task 2): Layout-Designer — LayoutDesign, unveraenderliche LayoutDesignVersion, Dunning.layoutVersionId"
# Praeambel woertlich wie Fall 28, Ausschluss nur der Phase-16g-Migration. Bestand im
# ALTEN Spaltenumfang: festgeschriebene Rechnung mit einer Mahnung.
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20261114090100_phase16g_layout|20261115090100_phase17a_erechnung|20261116090100_phase17d_auth|20261117090100_phase16d_postal|20261118090100_phase18c_belegfluss|20261119090100_phase18e_payment_means|20261119100100_phase18d_api_indexes|20261120090100_phase18f_usage|20261121090100_kundenportal|20261122090100_bankabgleich|20261123090100_sammelrechnung|20261124090100_zahlungsaktionen|20261125090100_zahlungsanbieter|20261126090100_stripe|20261127090100_datev|20261128090100_pflichtpruefungen|20261129090100_eingangsrechnungen|20261130090100_eingang_ablauf)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org29','Bestand Neunundzwanzig GmbH','Weg 41','99941','Bestadt',NOW());
INSERT INTO "Customer" ("id","orgId","name","addressLine1","postalCode","city","updatedAt")
  VALUES ('cust29','org29','Bestand Neunundzwanzig Kunde AG','Weg 42','99942','Bestadt',NOW());
INSERT INTO "Invoice" ("id","orgId","customerId","number","status","updatedAt")
  VALUES ('inv29','org29','cust29','RE-2029-00001','FINALIZED',NOW());
INSERT INTO "Dunning" ("id","invoiceId","level")
  VALUES ('dun29','inv29',1);
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Phase-16g-Migration ist auf der Bestands-DB fehlgeschlagen"
DUNVAL=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select coalesce(\"layoutVersionId\",'<null>') from \"Dunning\" where id='dun29'")
[ "$DUNVAL" = "<null>" ] || fail "Dunning.layoutVersionId abweichend ('$DUNVAL'), erwartet <null>"
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "LayoutDesign" ("id","orgId","name","updatedAt") VALUES ('ld29','org29','Hausdesign',NOW());
INSERT INTO "LayoutDesignVersion" ("id","designId","version","configJson","configHash")
  VALUES ('ldv29','ld29',1,'{"version":1}','hash29');
SQL
DEFVAL=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"baseLayoutId\" || '|' || \"currentVersion\" || '|' || \"archived\" from \"LayoutDesign\" where id='ld29'")
[ "$DEFVAL" = "standard|1|false" ] || fail "LayoutDesign-Defaults abweichend ('$DEFVAL'), erwartet standard|1|false"
if docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q \
  -c "INSERT INTO \"LayoutDesignVersion\" (\"id\",\"designId\",\"version\",\"configJson\",\"configHash\") VALUES ('ldv29b','ld29',1,'{}','h')" >/dev/null 2>&1; then
  fail "zweite LayoutDesignVersion mit gleichem (designId, version) haette scheitern muessen"
fi
if docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q \
  -c "INSERT INTO \"LayoutDesign\" (\"id\",\"orgId\",\"name\",\"updatedAt\") VALUES ('ld29b','org29','Hausdesign',NOW())" >/dev/null 2>&1; then
  fail "zweites LayoutDesign mit gleichem Namen je Organisation haette scheitern muessen"
fi
COUNT29=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT29" = "$TABLES_EXPECTED" ] || fail "erwartet ${TABLES_EXPECTED} Tabellen nach Phase 16g, gefunden $COUNT29"
echo "    ok — Dunning.layoutVersionId NULL auf Bestand, Design + Version 1 einfuegbar, doppelte (designId, version) und doppelter Name je Organisation scheitern, ${TABLES_EXPECTED} Tabellen"

echo "==> Fall 30 (Phase 17a, Task 1): E-Rechnung/Steuer — EAS-Schemacodes, BT-47, VIES-Einstellungen, VatIdCheck"
# Praeambel woertlich wie Fall 29, Ausschluss nur der Phase-17a-Migration. Bestand im ALTEN
# Spaltenumfang: Organisation, Kunde und DocumentSettings.
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20261115090100_phase17a_erechnung|20261116090100_phase17d_auth|20261117090100_phase16d_postal|20261118090100_phase18c_belegfluss|20261119090100_phase18e_payment_means|20261119100100_phase18d_api_indexes|20261120090100_phase18f_usage|20261121090100_kundenportal|20261122090100_bankabgleich|20261123090100_sammelrechnung|20261124090100_zahlungsaktionen|20261125090100_zahlungsanbieter|20261126090100_stripe|20261127090100_datev|20261128090100_pflichtpruefungen|20261129090100_eingangsrechnungen|20261130090100_eingang_ablauf)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org30','Bestand Dreissig GmbH','Weg 51','99951','Bestadt',NOW());
INSERT INTO "Customer" ("id","orgId","name","addressLine1","postalCode","city","updatedAt")
  VALUES ('cust30','org30','Bestand Dreissig Kunde AG','Weg 52','99952','Bestadt',NOW());
INSERT INTO "DocumentSettings" ("id","orgId","updatedAt")
  VALUES ('ds30','org30',NOW());
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Phase-17a-Migration ist auf der Bestands-DB fehlgeschlagen"
NEWVAL=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select coalesce(o.\"electronicAddressScheme\",'<null>') || '|' || coalesce(c.\"peppolScheme\",'<null>') || '|' || coalesce(c.\"legalRegistrationId\",'<null>') from \"Organization\" o, \"Customer\" c where o.id='org30' and c.id='cust30'")
[ "$NEWVAL" = "<null>|<null>|<null>" ] || fail "neue Stammdatenfelder abweichend ('$NEWVAL'), erwartet <null>|<null>|<null>"
VIESVAL=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"viesCheckEnabled\" || '|' || \"viesCheckOnFinalize\" from \"DocumentSettings\" where id='ds30'")
[ "$VIESVAL" = "true|false" ] || fail "DocumentSettings VIES-Defaults abweichend ('$VIESVAL'), erwartet true|false"
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "VatIdCheck" ("id","orgId","customerId","vatId","status","trigger")
  VALUES ('vic30','org30','cust30','ATU12345678','VALID','MANUAL');
SQL
COUNT30=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT30" = "$TABLES_EXPECTED" ] || fail "erwartet ${TABLES_EXPECTED} Tabellen nach Phase 17a, gefunden $COUNT30"
echo "    ok — EAS-Schema/peppolScheme/BT-47 NULL auf Bestand, VIES-Defaults true|false, VatIdCheck einfuegbar, ${TABLES_EXPECTED} Tabellen"

echo "==> Fall 31 (Phase 17d, Task 1): Konto-Sicherheit — TOTP-Spalten, RecoveryCode, PasswordResetToken"
# Praeambel woertlich wie Fall 30, Ausschluss nur der Phase-17d-Migration. Bestand im ALTEN
# Spaltenumfang: zwei Nutzer (einer mit Fehlversuchen). Die Phase-17d-Migration ist unabhaengig
# von der Login-Haertung (Fall 25) und rein additiv.
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20261116090100_phase17d_auth|20261117090100_phase16d_postal|20261118090100_phase18c_belegfluss|20261119090100_phase18e_payment_means|20261119100100_phase18d_api_indexes|20261120090100_phase18f_usage|20261121090100_kundenportal|20261122090100_bankabgleich|20261123090100_sammelrechnung|20261124090100_zahlungsaktionen|20261125090100_zahlungsanbieter|20261126090100_stripe|20261127090100_datev|20261128090100_pflichtpruefungen|20261129090100_eingangsrechnungen|20261130090100_eingang_ablauf)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "User" ("id","email","passwordHash","createdAt")
  VALUES ('user31','bestand31@example.com','x:y',NOW()), ('user31b','bestand31b@example.com','x:y',NOW());
UPDATE "User" SET "failedLoginCount"=3 WHERE id='user31';
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Phase-17d-Migration ist auf der Bestands-DB fehlgeschlagen"
USRVAL=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select coalesce(\"totpSecretEnc\",'<null>') || '|' || coalesce(\"totpEnabledAt\"::text,'<null>') || '|' || coalesce(\"totpLastStep\"::text,'<null>') || '|' || \"failedLoginCount\" from \"User\" where id='user31'")
[ "$USRVAL" = "<null>|<null>|<null>|3" ] || fail "User-Bestand abweichend ('$USRVAL'), erwartet <null>|<null>|<null>|3"
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "RecoveryCode" ("id","userId","codeHash") VALUES ('rc31','user31','hash-a');
INSERT INTO "RecoveryCode" ("id","userId","codeHash") VALUES ('rc31b','user31b','hash-a');
INSERT INTO "PasswordResetToken" ("id","userId","tokenHash","expiresAt")
  VALUES ('prt31','user31','tokenhash-a',NOW() + interval '30 minutes');
SQL
if docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q \
  -c "INSERT INTO \"RecoveryCode\" (\"id\",\"userId\",\"codeHash\") VALUES ('rc31c','user31','hash-a')" >/dev/null 2>&1; then
  fail "zweiter RecoveryCode mit gleichem (userId, codeHash) haette scheitern muessen"
fi
if docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q \
  -c "INSERT INTO \"PasswordResetToken\" (\"id\",\"userId\",\"tokenHash\",\"expiresAt\") VALUES ('prt31b','user31b','tokenhash-a',NOW())" >/dev/null 2>&1; then
  fail "zweiter PasswordResetToken mit gleichem tokenHash haette scheitern muessen"
fi
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "PasswordResetToken" ("id","userId","tokenHash","expiresAt")
  VALUES ('prt31c','user31b','tokenhash-b',NOW() + interval '30 minutes');
DELETE FROM "User" WHERE id='user31b';
SQL
CASCVAL=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select (select count(*) from \"RecoveryCode\" where \"userId\"='user31b') || '|' || (select count(*) from \"PasswordResetToken\" where \"userId\"='user31b')")
[ "$CASCVAL" = "0|0" ] || fail "Kindtabellen folgen User nicht per ON DELETE CASCADE ('$CASCVAL'), erwartet 0|0"
COUNT31=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT31" = "$TABLES_EXPECTED" ] || fail "erwartet ${TABLES_EXPECTED} Tabellen nach Phase 17d, gefunden $COUNT31"
echo "    ok — TOTP-Spalten NULL auf Bestand (failedLoginCount unveraendert), RecoveryCode/PasswordResetToken einfuegbar, doppelte (userId, codeHash) und tokenHash scheitern, ON DELETE CASCADE, ${TABLES_EXPECTED} Tabellen"

docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
UPDATE "User" SET "totpSecretEnc"='v1:x', "totpEnabledAt"=NOW(), "totpLastStep"=1, "failedLoginCount"=5, "lockedUntil"=NOW() + interval '10 minutes' WHERE id='user31';
SQL
sh scripts/disable-2fa.sh --bestaetigen --email bestand31@example.com >/dev/null \
  || fail "Notfallskript disable-2fa.sh ist auf Postgres fehlgeschlagen"
NOTVAL=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select coalesce(\"totpSecretEnc\",'<null>') || '|' || coalesce(\"totpEnabledAt\"::text,'<null>') || '|' || coalesce(\"totpLastStep\"::text,'<null>') || '|' || \"failedLoginCount\" from \"User\" where id='user31'")
[ "$NOTVAL" = "<null>|<null>|<null>|0" ] || fail "Notfallskript: User abweichend ('$NOTVAL'), erwartet <null>|<null>|<null>|0"
NOTCODES=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from \"RecoveryCode\" where \"userId\"='user31'")
[ "$NOTCODES" = "0" ] || fail "Notfallskript: Wiederherstellungscodes nicht geloescht ($NOTCODES)"
echo "    ok — Notfallskript disable-2fa.sh schaltet 2FA ab und loescht Codes (Postgres)"

# Erfolg: passwordChangedAt gesetzt (beendet Sitzungen), offene Reset-Tokens entwertet.
PWC=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select (\"passwordChangedAt\" is not null) from \"User\" where id='user31'")
[ "$PWC" = "t" ] || fail "Notfallskript: passwordChangedAt nicht gesetzt ('$PWC')"
OPENTOK=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from \"PasswordResetToken\" where \"userId\"='user31' and \"usedAt\" is null")
[ "$OPENTOK" = "0" ] || fail "Notfallskript: offene Reset-Tokens nicht entwertet ($OPENTOK)"

# Gueltige, aber unbekannte Adresse: Exit 1 und keine Aenderung.
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
UPDATE "User" SET "totpSecretEnc"='v1:y', "totpEnabledAt"=NOW(), "totpLastStep"=2 WHERE id='user31b' OR id='user31';
INSERT INTO "PasswordResetToken" ("id","userId","tokenHash","expiresAt")
  VALUES ('prt31d','user31','tokenhash-d',NOW() + interval '30 minutes');
SQL
VORHER=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) || '|' || count(\"totpSecretEnc\") || '|' || (select count(*) from \"PasswordResetToken\" where \"usedAt\" is null) from \"User\"")
if sh scripts/disable-2fa.sh --bestaetigen --email unbekannt31@example.com >/dev/null 2>&1; then
  fail "Notfallskript: unbekannte Adresse muss mit Exit 1 enden"
fi
NACHHER=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) || '|' || count(\"totpSecretEnc\") || '|' || (select count(*) from \"PasswordResetToken\" where \"usedAt\" is null) from \"User\"")
[ "$VORHER" = "$NACHHER" ] || fail "Notfallskript: unbekannte Adresse hat Daten veraendert ('$VORHER' -> '$NACHHER')"
echo "    ok — Notfallskript: passwordChangedAt gesetzt, Reset-Tokens entwertet, unbekannte Adresse Exit 1 ohne Aenderung (Postgres)"

echo "==> Fall 32 (Phase 16d, Task 1): Postversand — Kanalspalten, PostalSettings, PostalJob, PostalJobEvent"
# Praeambel woertlich wie Fall 31, Ausschluss nur der Phase-16d-Migration. Bestand im ALTEN
# Spaltenumfang: Organisation, Kunde, Mahnstufe. Die Migration ist rein additiv.
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20261117090100_phase16d_postal|20261118090100_phase18c_belegfluss|20261119090100_phase18e_payment_means|20261119100100_phase18d_api_indexes|20261120090100_phase18f_usage|20261121090100_kundenportal|20261122090100_bankabgleich|20261123090100_sammelrechnung|20261124090100_zahlungsaktionen|20261125090100_zahlungsanbieter|20261126090100_stripe|20261127090100_datev|20261128090100_pflichtpruefungen|20261129090100_eingangsrechnungen|20261130090100_eingang_ablauf)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org32','Bestand Zweiunddreissig GmbH','Weg 32','99932','Bestadt',NOW());
INSERT INTO "Customer" ("id","orgId","name","addressLine1","postalCode","city","countryCode","updatedAt")
  VALUES ('cust32','org32','Zweiunddreissig-Kunde GmbH','Kundenweg 32','99932','Bestadt','DE',NOW());
INSERT INTO "DunningStage" ("id","orgId","order","name","daysAfterDue","calculateInterest","includeB2BFlatFee","updatedAt")
  VALUES ('ds32','org32',1,'Erinnerung',7,false,false,NOW());
INSERT INTO "NotificationSettings" ("id","orgId","enabledTypesJson","updatedAt")
  VALUES ('ns32','org32','["INVOICE_OVERDUE"]',NOW());
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Phase-16d-Migration ist auf der Bestands-DB fehlgeschlagen"
CHVAL=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"deliveryChannel\" from \"Customer\" where id='cust32'")
[ "$CHVAL" = "EMAIL" ] || fail "Customer.deliveryChannel abweichend ('$CHVAL'), erwartet EMAIL"
STVAL=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"channel\"||'|'||\"postFallback\"::text from \"DunningStage\" where id='ds32'")
[ "$STVAL" = "CUSTOMER|true" ] || fail "DunningStage-Bestand abweichend ('$STVAL'), erwartet CUSTOMER|true"
NS32=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"enabledTypesJson\" from \"NotificationSettings\" where id='ns32'")
[ "$NS32" = '["INVOICE_OVERDUE","POSTAL_FAILED","POSTAL_PENDING","DUNNING_NOT_SENT","PAYMENT_RULE","PAYMENT_RULE_FAILED","ONLINE_OVERPAYMENT","ONLINE_PAYMENT_ISSUE","DATEV_LATE_ITEMS","KU_THRESHOLD","INCOMING_DUE"]' ] || fail "NotificationSettings.enabledTypesJson ohne Postversand-/Zahlungsregel-/Online-Zahlungs-/DATEV-/Umsatzgrenzen-Typen ergaenzt ('$NS32')"
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "PostalSettings" ("id","orgId","updatedAt") VALUES ('ps32','org32',NOW());
SQL
PSVAL=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"enabled\"::text||'|'||\"mode\"||'|'||\"autoDunningPost\"::text from \"PostalSettings\" where id='ps32'")
[ "$PSVAL" = "false|DRY_RUN|false" ] || fail "PostalSettings-Defaults abweichend ('$PSVAL'), erwartet false|DRY_RUN|false"
if docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q \
  -c "INSERT INTO \"PostalSettings\" (\"id\",\"orgId\",\"updatedAt\") VALUES ('ps32b','org32',NOW())" >/dev/null 2>&1; then
  fail "zweite PostalSettings-Zeile je Organisation haette scheitern muessen"
fi
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "PostalJob" ("id","orgId","docType","docId","invoiceId","docNumber","mode","trigger","status","filename","pages","color","duplex","shipping","pdfSha256","base64Md5","createdBy")
  VALUES ('pj32a','org32','INVOICE','doc32a','inv32a','RE-32-A','DRY_RUN','USER','DRY_RUN','RE-32-A-1.pdf',1,'1',false,'auto','sha-a','md5-a','user'),
         ('pj32b','org32','INVOICE','doc32b','inv32b','RE-32-B','DRY_RUN','USER','DRY_RUN','RE-32-B-1.pdf',1,'1',false,'auto','sha-b','md5-b','user');
INSERT INTO "PostalJob" ("id","orgId","docType","docId","invoiceId","docNumber","mode","trigger","status","providerJobId","filename","pages","color","duplex","shipping","pdfSha256","base64Md5","createdBy")
  VALUES ('pj32c','org32','INVOICE','doc32c','inv32c','RE-32-C','TEST','USER','QUEUED',4711,'RE-32-C-1.pdf',1,'1',false,'auto','sha-c','md5-c','user');
INSERT INTO "PostalJobEvent" ("id","jobId","orgId","kind","status") VALUES ('pe32','pj32c','org32','CREATED','QUEUED');
SQL
if docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q \
  -c "INSERT INTO \"PostalJob\" (\"id\",\"orgId\",\"docType\",\"docId\",\"invoiceId\",\"docNumber\",\"mode\",\"trigger\",\"status\",\"providerJobId\",\"filename\",\"pages\",\"color\",\"duplex\",\"shipping\",\"pdfSha256\",\"base64Md5\",\"createdBy\") VALUES ('pj32d','org32','INVOICE','doc32d','inv32d','RE-32-D','TEST','USER','QUEUED',4711,'RE-32-D-1.pdf',1,'1',false,'auto','sha-d','md5-d','user')" >/dev/null 2>&1; then
  fail "doppeltes (provider, providerJobId) haette scheitern muessen"
fi
if docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q \
  -c "DELETE FROM \"PostalJob\" WHERE id='pj32c'" >/dev/null 2>&1; then
  fail "PostalJob mit Ereignis haette sich nicht loeschen lassen duerfen (ON DELETE RESTRICT)"
fi
if docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q \
  -c "INSERT INTO \"PostalJob\" (\"id\",\"orgId\",\"docType\",\"docId\",\"invoiceId\",\"docNumber\",\"mode\",\"trigger\",\"status\",\"filename\",\"pages\",\"color\",\"duplex\",\"shipping\",\"pdfSha256\",\"base64Md5\",\"createdBy\") VALUES ('pj32e','org32','INVOICE','doc32e','inv32e','RE-32-E','DRY_RUN','USER','DRY_RUN','RE-32-A-1.pdf',1,'1',false,'auto','sha-e','md5-e','user')" >/dev/null 2>&1; then
  fail "doppelter filename je Organisation haette scheitern muessen"
fi
docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from pg_indexes where indexname in ('PostalJob_orgId_filename_key','PostalJob_invoiceId_status_idx')" | grep -qx 2 || fail "Index PostalJob_invoiceId_status_idx oder PostalJob_orgId_filename_key fehlt"
COUNT32=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT32" = "$TABLES_EXPECTED" ] || fail "erwartet ${TABLES_EXPECTED} Tabellen nach Phase 16d, gefunden $COUNT32"
echo "    ok — deliveryChannel EMAIL und Mahnstufe CUSTOMER|true auf Bestand, PostalSettings-Defaults false|DRY_RUN|false, zweite Zeile je Organisation scheitert, zwei Jobs ohne providerJobId ok, doppeltes (provider, providerJobId) scheitert, Job mit Ereignis nicht loeschbar (RESTRICT), ${TABLES_EXPECTED} Tabellen"

echo "==> Fall 33 (Phase 18c, Task 1): Belegfluss — Abo-Positionsbloecke, HTML-Schalter der Mail-Einstellungen"
# Praeambel woertlich wie Fall 32, Ausschluss nur der Phase-18c-Migration. Bestand im ALTEN
# Spaltenumfang: Organisation, Kunde, Abo mit Zeile, Mail-Einstellungen. Die Migration ist rein additiv.
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20261118090100_phase18c_belegfluss|20261119090100_phase18e_payment_means|20261119100100_phase18d_api_indexes|20261120090100_phase18f_usage|20261121090100_kundenportal|20261122090100_bankabgleich|20261123090100_sammelrechnung|20261124090100_zahlungsaktionen|20261125090100_zahlungsanbieter|20261126090100_stripe|20261127090100_datev|20261128090100_pflichtpruefungen|20261129090100_eingangsrechnungen|20261130090100_eingang_ablauf)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org33','Bestand Dreiunddreissig GmbH','Weg 33','99933','Bestadt',NOW());
INSERT INTO "Customer" ("id","orgId","name","addressLine1","postalCode","city","countryCode","updatedAt")
  VALUES ('cust33','org33','Dreiunddreissig-Kunde GmbH','Kundenweg 33','99933','Bestadt','DE',NOW());
INSERT INTO "RecurringInvoice" ("id","orgId","customerId","title","startDate","nextRunDate","updatedAt")
  VALUES ('rec33','org33','cust33','Abo33',NOW(),NOW(),NOW());
INSERT INTO "RecurringInvoiceLine" ("id","recurringInvoiceId","position","description","quantityMilli","unitNetPriceCents","taxRate","discountPermille")
  VALUES ('rline33','rec33',1,'Abopos',1000,1000,19,50);
INSERT INTO "MailSettings" ("id","orgId","host","port","security","fromName","fromEmail","copyToSelf","updatedAt")
  VALUES ('ms33','org33','smtp.example.org',587,'STARTTLS','Bestand Absender','abo33@example.org',true,NOW());
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Phase-18c-Migration ist auf der Bestands-DB fehlgeschlagen"
RL33=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"lineType\" || '|' || \"discountCents\" || '|' || \"discountPermille\" || '|' || coalesce(\"descriptionLong\",'<null>') || '|' || coalesce(\"articleNumber\",'<null>') || '|' || coalesce(\"productId\",'<null>') from \"RecurringInvoiceLine\" where id='rline33'")
[ "$RL33" = "ITEM|0|50|<null>|<null>|<null>" ] || fail "Abo-Zeile auf Bestand abweichend ('$RL33'), erwartet ITEM|0|50|<null>|<null>|<null>"
MS33=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"htmlEnabled\"::text || '|' || \"copyToSelf\"::text from \"MailSettings\" where id='ms33'")
[ "$MS33" = "false|true" ] || fail "MailSettings auf Bestand abweichend ('$MS33'), erwartet false|true"
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "RecurringInvoiceLine" ("id","recurringInvoiceId","position","description","quantityMilli","unitNetPriceCents","taxRate","lineType","descriptionLong")
  VALUES ('rline33h','rec33',2,'Abschnitt',0,0,0,'HEADING','Langtext zur Ueberschrift');
SQL
COUNT33=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT33" = "$TABLES_EXPECTED" ] || fail "erwartet ${TABLES_EXPECTED} Tabellen nach Phase 18c, gefunden $COUNT33"
echo "    ok — Abo-Zeilen ITEM ohne Rabatt auf Bestand, HTML aus, HEADING einfuegbar, ${TABLES_EXPECTED} Tabellen"

echo "==> Fall 34 (Phase 18e, Task 1): Zahlungsmittel — Glaeubiger-ID, Lastschriftmandat am Kunden, Kartenfelder und Lastschrift-Snapshot am Beleg"
# Praeambel woertlich wie Fall 33, Ausschluss nur der Phase-18e-Migration. Bestand im ALTEN
# Spaltenumfang: Organisation, Kunde, festgeschriebene Rechnung. Die Migration ist rein additiv.
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20261119090100_phase18e_payment_means|20261119100100_phase18d_api_indexes|20261120090100_phase18f_usage|20261121090100_kundenportal|20261122090100_bankabgleich|20261123090100_sammelrechnung|20261124090100_zahlungsaktionen|20261125090100_zahlungsanbieter|20261126090100_stripe|20261127090100_datev|20261128090100_pflichtpruefungen|20261129090100_eingangsrechnungen|20261130090100_eingang_ablauf)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org34','Bestand Vierunddreissig GmbH','Weg 34','99934','Bestadt',NOW());
INSERT INTO "Customer" ("id","orgId","name","addressLine1","postalCode","city","countryCode","updatedAt")
  VALUES ('cust34','org34','Vierunddreissig-Kunde GmbH','Kundenweg 34','99934','Bestadt','DE',NOW());
INSERT INTO "Invoice" ("id","orgId","customerId","number","status","updatedAt")
  VALUES ('inv34','org34','cust34','PG34-0001','FINALIZED',NOW());
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Phase-18e-Migration ist auf der Bestands-DB fehlgeschlagen"
ORG34=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select coalesce(\"sepaCreditorId\",'<null>') from \"Organization\" where id='org34'")
[ "$ORG34" = "<null>" ] || fail "Organisation auf Bestand abweichend ('$ORG34'), erwartet <null>"
CUST34=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select coalesce(\"sepaMandateReference\",'<null>') || '|' || coalesce(\"sepaMandateSignedAt\"::text,'<null>') || '|' || coalesce(\"sepaDebitIban\",'<null>') || '|' || coalesce(\"sepaDebitAccountName\",'<null>') from \"Customer\" where id='cust34'")
[ "$CUST34" = "<null>|<null>|<null>|<null>" ] || fail "Kunde auf Bestand abweichend ('$CUST34'), erwartet <null>|<null>|<null>|<null>"
INV34=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select coalesce(\"cardPanTruncated\",'<null>') || '|' || coalesce(\"cardHolderName\",'<null>') || '|' || coalesce(\"cardNetwork\",'<null>') || '|' || coalesce(\"directDebitSnapshotJson\",'<null>') from \"Invoice\" where id='inv34'")
[ "$INV34" = "<null>|<null>|<null>|<null>" ] || fail "Rechnung auf Bestand abweichend ('$INV34'), erwartet <null>|<null>|<null>|<null>"
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL' || fail "Lastschriftmandat am Kunden nicht speicherbar"
UPDATE "Customer" SET "sepaMandateReference"='MANDAT-2180-001', "sepaMandateSignedAt"='2180-01-15 00:00:00',
  "sepaDebitIban"='DE02120300000000202051', "sepaDebitAccountName"='Vierunddreissig-Kunde GmbH' WHERE id='cust34';
SQL
DT34=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select data_type from information_schema.columns where table_name='Customer' and column_name='sepaMandateSignedAt'")
[ "$DT34" = "timestamp without time zone" ] || fail "sepaMandateSignedAt hat Typ '$DT34', erwartet timestamp without time zone"
COUNT34=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT34" = "$TABLES_EXPECTED" ] || fail "erwartet ${TABLES_EXPECTED} Tabellen nach Phase 18e, gefunden $COUNT34"
echo "    ok — SEPA-/Kartenspalten NULL auf Bestand, Mandat speicherbar, ${TABLES_EXPECTED} Tabellen"

echo "==> Fall 35 (Phase 18d, Task 1): API-Abgleich — Indizes (orgId, updatedAt)"
# Praeambel woertlich wie Fall 34, Ausschluss nur der Phase-18d-Migration. Bestand im ALTEN
# Umfang: Organisation, Kunde, Produkt. Die Migration legt nur Indizes an.
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20261119100100_phase18d_api_indexes|20261120090100_phase18f_usage|20261121090100_kundenportal|20261122090100_bankabgleich|20261123090100_sammelrechnung|20261124090100_zahlungsaktionen|20261125090100_zahlungsanbieter|20261126090100_stripe|20261127090100_datev|20261128090100_pflichtpruefungen|20261129090100_eingangsrechnungen|20261130090100_eingang_ablauf)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org35','Bestand Fuenfunddreissig GmbH','Weg 35','99935','Bestadt',NOW());
INSERT INTO "Customer" ("id","orgId","name","addressLine1","postalCode","city","countryCode","updatedAt")
  VALUES ('cust35','org35','Fuenfunddreissig-Kunde GmbH','Kundenweg 35','99935','Bestadt','DE',NOW());
INSERT INTO "Product" ("id","orgId","name","netPriceCents","updatedAt")
  VALUES ('prod35','org35','Produkt35',1000,NOW());
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Phase-18d-Migration ist auf der Bestands-DB fehlgeschlagen"
COUNT35IDX=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from pg_indexes where schemaname='public' and indexname in ('Invoice_orgId_updatedAt_idx','Quote_orgId_updatedAt_idx','DeliveryNote_orgId_updatedAt_idx','Customer_orgId_updatedAt_idx','Product_orgId_updatedAt_idx')")
[ "$COUNT35IDX" = "5" ] || fail "erwartet 5 Indizes (orgId, updatedAt), gefunden $COUNT35IDX"
IDXDEF35=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select pg_get_indexdef('\"Customer_orgId_updatedAt_idx\"'::regclass)")
case "$IDXDEF35" in
  *'("orgId", "updatedAt")'*) ;;
  *) fail "Customer_orgId_updatedAt_idx hat Definition '$IDXDEF35', erwartet (\"orgId\", \"updatedAt\")" ;;
esac
CUST35=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select name from \"Customer\" where id='cust35'")
[ "$CUST35" = "Fuenfunddreissig-Kunde GmbH" ] || fail "Kunde auf Bestand abweichend ('$CUST35')"
COUNT35=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT35" = "$TABLES_EXPECTED" ] || fail "erwartet ${TABLES_EXPECTED} Tabellen nach Phase 18d, gefunden $COUNT35"
echo "    ok — 5 Indizes (orgId, updatedAt), Bestand unveraendert, $COUNT35 Tabellen"

echo "==> Fall 36 (Phase 18f, Task 1): Abo-Verbrauch — Milli-Cent-Preise, Abrechnungsart, RecurringUsage"
# Praeambel woertlich wie Fall 34, Ausschluss nur der Phase-18f-Migration. Bestand im ALTEN
# Spaltenumfang: Rechnung (festgeschrieben + Entwurf) mit Zeile, Angebot mit Zeile, Abo mit Zeile.
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20261120090100_phase18f_usage|20261121090100_kundenportal|20261122090100_bankabgleich|20261123090100_sammelrechnung|20261124090100_zahlungsaktionen|20261125090100_zahlungsanbieter|20261126090100_stripe|20261127090100_datev|20261128090100_pflichtpruefungen|20261129090100_eingangsrechnungen|20261130090100_eingang_ablauf)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org35x','Bestand Sechsunddreissig GmbH','Weg 36','99936','Bestadt',NOW());
INSERT INTO "Customer" ("id","orgId","name","addressLine1","postalCode","city","countryCode","updatedAt")
  VALUES ('cust35x','org35x','Sechsunddreissig-Kunde GmbH','Kundenweg 36','99936','Bestadt','DE',NOW());
INSERT INTO "Invoice" ("id","orgId","customerId","number","status","updatedAt")
  VALUES ('inv35','org35x','cust35x','RE-2185-35001','FINALIZED',NOW());
INSERT INTO "InvoiceLine" ("id","invoiceId","position","description","quantityMilli","unitNetPriceCents","taxRate","taxCategory","lineNetCents")
  VALUES ('il35','inv35',1,'Bestandsposition',1000,1000,19,'S',1000);
INSERT INTO "Invoice" ("id","orgId","customerId","status","updatedAt")
  VALUES ('inv35d','org35x','cust35x','DRAFT',NOW());
INSERT INTO "Quote" ("id","orgId","customerId","status","updatedAt")
  VALUES ('q35','org35x','cust35x','DRAFT',NOW());
INSERT INTO "QuoteLine" ("id","quoteId","position","description","quantityMilli","unitNetPriceCents","taxRate","taxCategory","lineNetCents")
  VALUES ('ql35','q35',1,'Bestandsposition',1000,1000,19,'S',1000);
INSERT INTO "RecurringInvoice" ("id","orgId","customerId","title","startDate","nextRunDate","updatedAt")
  VALUES ('rec35','org35x','cust35x','Bestands-Abo','2026-01-01','2026-02-01',NOW());
INSERT INTO "RecurringInvoiceLine" ("id","recurringInvoiceId","position","description","quantityMilli","unitNetPriceCents","taxRate","taxCategory","discountPermille")
  VALUES ('rl35','rec35',1,'Bestandsposition',1000,1000,19,'S',0);
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Phase-18f-Migration ist auf der Bestands-DB fehlgeschlagen"
IL35=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select coalesce(\"unitNetPriceMilliCents\"::text,'<null>') || '|' || coalesce(\"servicePeriodStart\"::text,'<null>') from \"InvoiceLine\" where id='il35'")
[ "$IL35" = "<null>|<null>" ] || fail "Rechnungszeile auf Bestand abweichend ('$IL35'), erwartet <null>|<null>"
QL35=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select coalesce(\"unitNetPriceMilliCents\"::text,'<null>') from \"QuoteLine\" where id='ql35'")
[ "$QL35" = "<null>" ] || fail "Angebotszeile auf Bestand abweichend ('$QL35'), erwartet <null>"
RL35=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"billing\" || '|' || coalesce(\"usageUnitLabel\",'<null>') || '|' || coalesce(\"unitNetPriceMilliCents\"::text,'<null>') from \"RecurringInvoiceLine\" where id='rl35'")
[ "$RL35" = "FIXED|<null>|<null>" ] || fail "Abo-Zeile auf Bestand abweichend ('$RL35'), erwartet FIXED|<null>|<null>"
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL' || fail "RecurringUsage nicht speicherbar"
INSERT INTO "RecurringUsage" ("id","orgId","recurringInvoiceId","recurringLineId","usageDate","periodStart","periodEnd","quantityMilli","source","externalId","createdBy","invoiceId")
  VALUES ('u35a','org35x','rec35','rl35','2185-01-10','2185-01-01','2185-01-31',5000,'API','ev-1','user','inv35d');
INSERT INTO "RecurringUsage" ("id","orgId","recurringInvoiceId","recurringLineId","usageDate","periodStart","periodEnd","quantityMilli","source","externalId","createdBy")
  VALUES ('u35b','org35x','rec35','rl35','2185-01-11','2185-01-01','2185-01-31',1000,'UI',NULL,'user');
INSERT INTO "RecurringUsage" ("id","orgId","recurringInvoiceId","recurringLineId","usageDate","periodStart","periodEnd","quantityMilli","source","externalId","createdBy")
  VALUES ('u35c','org35x','rec35','rl35','2185-01-12','2185-01-01','2185-01-31',2000,'UI',NULL,'user');
SQL
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q >/dev/null 2>&1 <<'SQL' && fail "Doppelte externalId je Abo wurde nicht abgewiesen"
INSERT INTO "RecurringUsage" ("id","orgId","recurringInvoiceId","usageDate","periodStart","periodEnd","quantityMilli","source","externalId","createdBy")
  VALUES ('u35dup','org35x','rec35','2185-01-13','2185-01-01','2185-01-31',1000,'API','ev-1','user');
SQL
docker exec "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q \
  -c "DELETE FROM \"Invoice\" WHERE id='inv35d'" >/dev/null || fail "Entwurf mit Verbrauchsverknuepfung nicht loeschbar"
U35A=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select coalesce(\"invoiceId\",'<null>') from \"RecurringUsage\" where id='u35a'")
[ "$U35A" = "<null>" ] || fail "invoiceId nach Entwurfsloeschung nicht NULL ('$U35A')"
docker exec "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q \
  -c "DELETE FROM \"RecurringInvoiceLine\" WHERE id='rl35'" >/dev/null || fail "Abo-Zeile nicht loeschbar"
U35B=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select coalesce(\"recurringLineId\",'<null>') from \"RecurringUsage\" where id='u35b'")
[ "$U35B" = "<null>" ] || fail "recurringLineId nach Zeilenloeschung nicht NULL ('$U35B')"
docker exec "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q \
  -c "DELETE FROM \"RecurringInvoice\" WHERE id='rec35'" >/dev/null 2>&1 && fail "Abo mit Verbrauchssaetzen wurde geloescht (RESTRICT erwartet)"
COUNT36=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT36" = "$TABLES_EXPECTED" ] || fail "erwartet $TABLES_EXPECTED Tabellen nach Phase 18f, gefunden $COUNT36"
echo "    ok — Bestand ohne Milli-Preis und FIXED, RecurringUsage mit Unique je Abo, SET NULL fuer Entwurf/Zeile, RESTRICT fuer Abo, ${TABLES_EXPECTED} Tabellen"

echo "==> Fall 37: Kundenportal — Einstellungen, Links, Abrufprotokoll"
# Praeambel woertlich wie Fall 36, Ausschluss nur der Kundenportal-Migration. Bestand: Organisation mit Kunde.
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20261121090100_kundenportal|20261122090100_bankabgleich|20261123090100_sammelrechnung|20261124090100_zahlungsaktionen|20261125090100_zahlungsanbieter|20261126090100_stripe|20261127090100_datev|20261128090100_pflichtpruefungen|20261129090100_eingangsrechnungen|20261130090100_eingang_ablauf)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org37x','Bestand Siebenunddreissig GmbH','Weg 37','99937','Bestadt',NOW());
INSERT INTO "Customer" ("id","orgId","name","addressLine1","postalCode","city","countryCode","updatedAt")
  VALUES ('cust37x','org37x','Siebenunddreissig-Kunde GmbH','Kundenweg 37','99937','Bestadt','DE',NOW());
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Kundenportal-Migration ist auf der Bestands-DB fehlgeschlagen"
PT37=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from information_schema.tables where table_schema='public' and table_name in ('CustomerPortalSettings','CustomerPortalLink','CustomerPortalEvent')")
[ "$PT37" = "3" ] || fail "Portal-Tabellen fehlen (gefunden $PT37, erwartet 3)"
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL' || fail "Portal-Zeilen nicht speicherbar"
INSERT INTO "CustomerPortalSettings" ("id","orgId","updatedAt") VALUES ('ps37','org37x',NOW());
INSERT INTO "CustomerPortalLink" ("id","orgId","customerId","tokenHash","tokenEnc","expiresAt","createdBy")
  VALUES ('pl37','org37x','cust37x','hash37','enc37',NOW() + interval '365 days','user');
INSERT INTO "CustomerPortalEvent" ("id","orgId","linkId","kind") VALUES ('pe37','org37x','pl37','VIEW');
SQL
PS37=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"enabled\"::text || '|' || \"linkDays\" || '|' || \"showDunnings\"::text || '|' || \"showEInvoice\"::text from \"CustomerPortalSettings\" where id='ps37'")
[ "$PS37" = "false|365|true|true" ] || fail "Portal-Einstellungen ohne Standardwerte ('$PS37'), erwartet false|365|true|true"
# Erwartet einen Fehler mit passender Ursache (SQL ueber stdin); ein Tippfehler im SQL darf den Test nicht gruen machen.
pg_expect_error() {
  local out
  if out=$(docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q 2>&1); then
    fail "$2 (es gab keinen Fehler)"
  fi
  echo "$out" | grep -Eq "$1" || fail "$2 — falsche Fehlerursache: $out"
}
pg_expect_error 'duplicate key value violates unique constraint "CustomerPortalLink_tokenHash_key"' "Doppelter tokenHash wurde nicht abgewiesen" <<'SQL'
INSERT INTO "CustomerPortalLink" ("id","orgId","customerId","tokenHash","tokenEnc","expiresAt","createdBy")
  VALUES ('pl37dup','org37x','cust37x','hash37','enc37',NOW(),'user');
SQL
pg_expect_error 'duplicate key value violates unique constraint "CustomerPortalSettings_orgId_key"' "Zweite Portal-Einstellung je Organisation wurde nicht abgewiesen" <<'SQL'
INSERT INTO "CustomerPortalSettings" ("id","orgId","updatedAt") VALUES ('ps37dup','org37x',NOW());
SQL
pg_expect_error 'violates foreign key constraint "CustomerPortalEvent_linkId_fkey"' "Abrufereignis ohne Link wurde nicht abgewiesen" <<'SQL'
INSERT INTO "CustomerPortalEvent" ("id","orgId","linkId","kind") VALUES ('pe37bad','org37x','gibt-es-nicht','VIEW');
SQL
pg_expect_error 'violates foreign key constraint "CustomerPortalEvent_linkId_fkey"' "Link mit Abrufereignis wurde geloescht (RESTRICT erwartet)" <<'SQL'
DELETE FROM "CustomerPortalLink" WHERE id='pl37';
SQL
pg_expect_error 'violates foreign key constraint "CustomerPortalLink_customerId_fkey"' "Kunde mit Portal-Link wurde geloescht (RESTRICT erwartet)" <<'SQL'
DELETE FROM "Customer" WHERE id='cust37x';
SQL
COUNT37=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT37" = "$TABLES_EXPECTED" ] || fail "erwartet $TABLES_EXPECTED Tabellen nach Kundenportal, gefunden $COUNT37"
echo "    ok — Portal-Einstellungen mit Standardwerten false|365|true|true, Link und Abrufereignis einfuegbar, doppelter tokenHash und doppelte Einstellung scheitern (unique), Ereignis ohne Link, Link mit Ereignis und Kunde mit Link nicht loeschbar (foreign key), ${TABLES_EXPECTED} Tabellen"

echo "==> Fall 38: Bankabgleich — Importe, Umsaetze, Zuordnungen, Gegenkonto-Hinweise"
# Praeambel woertlich wie Fall 37, Ausschluss nur der Bankabgleich-Migration. Bestand: Organisation, Kunde, Rechnung, Zahlung.
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20261122090100_bankabgleich|20261123090100_sammelrechnung|20261124090100_zahlungsaktionen|20261125090100_zahlungsanbieter|20261126090100_stripe|20261127090100_datev|20261128090100_pflichtpruefungen|20261129090100_eingangsrechnungen|20261130090100_eingang_ablauf)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org38x','Bestand Achtunddreissig GmbH','Weg 38','99938','Bestadt',NOW());
INSERT INTO "Customer" ("id","orgId","name","addressLine1","postalCode","city","countryCode","updatedAt")
  VALUES ('cust38x','org38x','Achtunddreissig-Kunde GmbH','Kundenweg 38','99938','Bestadt','DE',NOW());
INSERT INTO "Invoice" ("id","orgId","customerId","number","status","updatedAt")
  VALUES ('inv38x','org38x','cust38x','RE-2205-38001','FINALIZED',NOW());
INSERT INTO "Payment" ("id","invoiceId","amountCents")
  VALUES ('pay38x','inv38x',1000);
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Bankabgleich-Migration ist auf der Bestands-DB fehlgeschlagen"
PT38=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from information_schema.tables where table_schema='public' and table_name in ('BankStatementImport','BankTransaction','BankMatch','BankCounterpartyHint')")
[ "$PT38" = "4" ] || fail "Bankabgleich-Tabellen fehlen (gefunden $PT38, erwartet 4)"
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL' || fail "Bankabgleich-Zeilen nicht speicherbar"
INSERT INTO "BankStatementImport" ("id","orgId","fileSha256","format","schemaVersion","entryCount","importedCount","duplicateCount","skippedCount","createdBy")
  VALUES ('bi38','org38x','sha38','CAMT053','camt.053.001.08',1,1,0,0,'user');
INSERT INTO "BankTransaction" ("id","orgId","importId","accountIban","fingerprint","bookingDate","amountCents","currency","direction","updatedAt")
  VALUES ('bt38','org38x','bi38','DE02120300000000202051','fp38','2205-02-01',1000,'EUR','CRDT',NOW());
INSERT INTO "BankMatch" ("id","orgId","transactionId","invoiceId","paymentId","amountCents","kind","confirmedBy")
  VALUES ('bm38','org38x','bt38','inv38x','pay38x',1000,'PAYMENT','user');
INSERT INTO "BankCounterpartyHint" ("id","orgId","ibanHash","customerId","lastUsedAt")
  VALUES ('bh38','org38x','hash38','cust38x',NOW());
SQL
BT38=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"status\" || '|' || \"allocatedCents\" from \"BankTransaction\" where id='bt38'")
[ "$BT38" = "OPEN|0" ] || fail "Bankumsatz ohne Standardwerte ('$BT38'), erwartet OPEN|0"
# Erwartet einen Fehler mit passender Ursache (pg_expect_error aus Fall 37).
pg_expect_error 'duplicate key value violates unique constraint "BankStatementImport_orgId_fileSha256_key"' "Doppelter Datei-Hash wurde nicht abgewiesen" <<'SQL'
INSERT INTO "BankStatementImport" ("id","orgId","fileSha256","format","schemaVersion","entryCount","importedCount","duplicateCount","skippedCount","createdBy")
  VALUES ('bi38dup','org38x','sha38','CAMT053','camt.053.001.08',1,1,0,0,'user');
SQL
pg_expect_error 'duplicate key value violates unique constraint "BankTransaction_orgId_fingerprint_key"' "Doppelter Fingerprint wurde nicht abgewiesen" <<'SQL'
INSERT INTO "BankTransaction" ("id","orgId","importId","accountIban","fingerprint","bookingDate","amountCents","currency","direction","updatedAt")
  VALUES ('bt38dup','org38x','bi38','DE02120300000000202051','fp38','2205-02-01',1000,'EUR','CRDT',NOW());
SQL
pg_expect_error 'duplicate key value violates unique constraint "BankMatch_paymentId_key"' "Doppelte paymentId wurde nicht abgewiesen" <<'SQL'
INSERT INTO "BankMatch" ("id","orgId","transactionId","invoiceId","paymentId","amountCents","kind","confirmedBy")
  VALUES ('bm38dup','org38x','bt38','inv38x','pay38x',1000,'PAYMENT','user');
SQL
pg_expect_error 'violates foreign key constraint "BankMatch_transactionId_fkey"' "Zuordnung ohne Umsatz wurde nicht abgewiesen" <<'SQL'
INSERT INTO "BankMatch" ("id","orgId","transactionId","invoiceId","amountCents","kind","confirmedBy")
  VALUES ('bm38bad','org38x','gibt-es-nicht','inv38x',1,'PAYMENT','user');
SQL
pg_expect_error 'violates foreign key constraint "BankMatch_transactionId_fkey"' "Umsatz mit Zuordnung wurde geloescht (RESTRICT erwartet)" <<'SQL'
DELETE FROM "BankTransaction" WHERE id='bt38';
SQL
COUNT38=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT38" = "$TABLES_EXPECTED" ] || fail "erwartet $TABLES_EXPECTED Tabellen nach Bankabgleich, gefunden $COUNT38"
echo "    ok — Umsatz mit Standardwerten OPEN|0, Import, Zuordnung mit Zahlung und Gegenkonto-Hinweis einfuegbar, doppelter Datei-Hash, Fingerprint und paymentId scheitern (unique), Zuordnung ohne Umsatz und Umsatz mit Zuordnung nicht loeschbar (foreign key), ${TABLES_EXPECTED} Tabellen"

echo "==> Fall 39: Sammelrechnung — Abo-Schalter, Blockueberschrift, Herkunft je Position"
# Praeambel wie Fall 38, Ausschluss nur der Sammelrechnung-Migration. Bestand: Organisation, Kunde, Abo, Rechnung, Position.
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20261123090100_sammelrechnung|20261124090100_zahlungsaktionen|20261125090100_zahlungsanbieter|20261126090100_stripe|20261127090100_datev|20261128090100_pflichtpruefungen|20261129090100_eingangsrechnungen|20261130090100_eingang_ablauf)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org39x','Bestand Neununddreissig GmbH','Weg 39','99939','Bestadt',NOW());
INSERT INTO "Customer" ("id","orgId","name","addressLine1","postalCode","city","countryCode","updatedAt")
  VALUES ('cust39x','org39x','Neununddreissig-Kunde GmbH','Kundenweg 39','99939','Bestadt','DE',NOW());
INSERT INTO "RecurringInvoice" ("id","orgId","customerId","title","startDate","nextRunDate","updatedAt")
  VALUES ('rec39x','org39x','cust39x','Bestandsabo',NOW(),NOW(),NOW());
INSERT INTO "Invoice" ("id","orgId","customerId","number","status","updatedAt")
  VALUES ('inv39x','org39x','cust39x','RE-2205-39001','FINALIZED',NOW());
INSERT INTO "InvoiceLine" ("id","invoiceId","position","description","quantityMilli","unitNetPriceCents","taxRate","lineNetCents")
  VALUES ('il39x','inv39x',1,'Bestandsposition',1000,1000,19,1000);
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Sammelrechnung-Migration ist auf der Bestands-DB fehlgeschlagen"
REC39=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"collectiveBilling\" || '|' || coalesce(\"invoiceHeading\",'') from \"RecurringInvoice\" where id='rec39x'")
[ "$REC39" = "false|" ] || fail "Abo ohne Standardwerte ('$REC39'), erwartet false|"
IL39=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from \"InvoiceLine\" where id='il39x' and \"recurringInvoiceId\" is null")
[ "$IL39" = "1" ] || fail "Bestandsposition hat eine Abo-Herkunft"
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL' || fail "Sammelrechnung-Spalten nicht beschreibbar"
UPDATE "RecurringInvoice" SET "collectiveBilling"=true, "invoiceHeading"='Wartung Standort A' WHERE id='rec39x';
INSERT INTO "InvoiceLine" ("id","invoiceId","position","description","quantityMilli","unitNetPriceCents","taxRate","lineNetCents","recurringInvoiceId")
  VALUES ('il39y','inv39x',2,'Position aus Abo',1000,1000,19,1000,'rec39x');
SQL
CT39=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select data_type from information_schema.columns where table_schema='public' and table_name='RecurringInvoice' and column_name='collectiveBilling'")
[ "$CT39" = "boolean" ] || fail "collectiveBilling hat Typ '$CT39', erwartet boolean"
COUNT39=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT39" = "$TABLES_EXPECTED" ] || fail "erwartet $TABLES_EXPECTED Tabellen nach Sammelrechnung, gefunden $COUNT39"
echo "    ok — Abo-Schalter false, Ueberschrift NULL, Positionsherkunft NULL auf Bestand, Werte setzbar, Typ boolean, ${TABLES_EXPECTED} Tabellen"

echo "==> Fall 40: Zahlungsaktionen — Regeln, Laeufe, Benachrichtigungstypen"
# Praeambel wie Fall 39, Ausschluss nur der Zahlungsaktionen-Migration. Bestand: Organisationen, Kunde, bezahlte Rechnung, Zahlung.
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20261124090100_zahlungsaktionen|20261125090100_zahlungsanbieter|20261126090100_stripe|20261127090100_datev|20261128090100_pflichtpruefungen|20261129090100_eingangsrechnungen|20261130090100_eingang_ablauf)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org40x','Bestand Vierzig GmbH','Weg 40','99940','Bestadt',NOW()),
         ('org40y','Bestand Vierzig Zwei GmbH','Weg 41','99941','Bestadt',NOW());
INSERT INTO "Customer" ("id","orgId","name","addressLine1","postalCode","city","countryCode","updatedAt")
  VALUES ('cust40x','org40x','Vierzig-Kunde GmbH','Kundenweg 40','99940','Bestadt','DE',NOW());
INSERT INTO "Invoice" ("id","orgId","customerId","number","status","updatedAt")
  VALUES ('inv40x','org40x','cust40x','RE-2210-40001','PAID',NOW());
INSERT INTO "Payment" ("id","invoiceId","amountCents","method")
  VALUES ('pay40x','inv40x',1000,'TRANSFER');
INSERT INTO "NotificationSettings" ("id","orgId","enabledTypesJson","updatedAt")
  VALUES ('ns40x','org40x','["INVOICE_OVERDUE"]',NOW()),
         ('ns40y','org40y','[]',NOW());
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Zahlungsaktionen-Migration ist auf der Bestands-DB fehlgeschlagen"
for NT in PAYMENT_RULE PAYMENT_RULE_FAILED; do
  for ORG in org40x org40y; do
    N40=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from \"NotificationSettings\" where \"orgId\"='$ORG' and \"enabledTypesJson\" like '%\"$NT\"%'")
    [ "$N40" = "1" ] || fail "Benachrichtigungstyp $NT fehlt bei $ORG"
  done
done
INV40=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select status from \"Invoice\" where id='inv40x'")
[ "$INV40" = "PAID" ] || fail "Bestandsrechnung veraendert ('$INV40')"
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL' || fail "Regel und Lauf nicht einfuegbar"
INSERT INTO "PaymentRule" ("id","orgId","name","trigger","actionsJson","updatedAt")
  VALUES ('rule40x','org40x','Bestaetigung','PAID_FULL','[{"type":"EMIT_WEBHOOK"}]',NOW());
INSERT INTO "PaymentRuleRun" ("id","orgId","ruleId","paymentId","invoiceId","customerId","trigger","source","actionsJson","stepsJson","contextJson","nextAttemptAt")
  VALUES ('run40x','org40x','rule40x','pay40x','inv40x','cust40x','PAID_FULL','MANUAL','[]','[]','{}',NOW());
SQL
RUN40=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select r.active::text || '|' || r.\"delayMinutes\"::text || '|' || u.status || '|' || u.attempts::text from \"PaymentRule\" r join \"PaymentRuleRun\" u on u.\"ruleId\"=r.id where r.id='rule40x'")
[ "$RUN40" = "true|5|PENDING|0" ] || fail "Standardwerte falsch ('$RUN40'), erwartet true|5|PENDING|0"
pg_expect_error 'duplicate key value violates unique constraint "PaymentRuleRun_ruleId_paymentId_key"' "Zweiter Lauf fuer (Regel, Zahlung) wurde nicht abgewiesen" <<'SQL'
INSERT INTO "PaymentRuleRun" ("id","orgId","ruleId","paymentId","invoiceId","customerId","trigger","source","actionsJson","stepsJson","contextJson","nextAttemptAt")
  VALUES ('run40dup','org40x','rule40x','pay40x','inv40x','cust40x','PAID_FULL','MANUAL','[]','[]','{}',NOW());
SQL
pg_expect_error 'violates foreign key constraint "PaymentRuleRun_ruleId_fkey"' "Regel mit Lauf wurde geloescht (RESTRICT erwartet)" <<'SQL'
DELETE FROM "PaymentRule" WHERE id='rule40x';
SQL
CT40=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select data_type from information_schema.columns where table_schema='public' and table_name='PaymentRule' and column_name='active'")
[ "$CT40" = "boolean" ] || fail "active hat Typ '$CT40', erwartet boolean"
COUNT40=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT40" = "$TABLES_EXPECTED" ] || fail "erwartet $TABLES_EXPECTED Tabellen nach Zahlungsaktionen, gefunden $COUNT40"
echo "    ok — beide Benachrichtigungstypen je Organisation ergaenzt, Regel/Lauf mit Standardwerten true|5|PENDING|0, doppelter Lauf scheitert (unique), Regel mit Lauf nicht loeschbar (foreign key), active boolean, ${TABLES_EXPECTED} Tabellen"

echo "==> Fall 41: Zahlungsanbieter — Konten, Bezahllinks, Vorgaenge, Ereignisse, Zahlungsart ONLINE"
# Praeambel wie Fall 40, Ausschluss nur der Zahlungsanbieter-Migration. Bestand: zwei Organisationen (eine mit eigener Zahlungsart ONLINE), Kunde, Rechnung.
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20261125090100_zahlungsanbieter|20261126090100_stripe|20261127090100_datev|20261128090100_pflichtpruefungen|20261129090100_eingangsrechnungen|20261130090100_eingang_ablauf)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org41a','Bestand Einundvierzig GmbH','Weg 41','99941','Bestadt',NOW()),
         ('org41b','Bestand Einundvierzig Zwei GmbH','Weg 42','99942','Bestadt',NOW());
INSERT INTO "PaymentMethod" ("id","orgId","code","name","untdidCode","isSystem","isActive","sortOrder","createdAt","updatedAt")
  VALUES ('pm41b','org41b','ONLINE','Eigene Online-Art','ZZZ',false,true,3,NOW(),NOW());
INSERT INTO "Customer" ("id","orgId","name","addressLine1","postalCode","city","countryCode","updatedAt")
  VALUES ('cust41a','org41a','Einundvierzig-Kunde GmbH','Kundenweg 41','99941','Bestadt','DE',NOW());
INSERT INTO "Invoice" ("id","orgId","customerId","number","status","updatedAt")
  VALUES ('inv41a','org41a','cust41a','RE-2215-41001','FINALIZED',NOW());
INSERT INTO "NotificationSettings" ("id","orgId","enabledTypesJson","updatedAt")
  VALUES ('ns41a','org41a','["INVOICE_OVERDUE"]',NOW());
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Zahlungsanbieter-Migration ist auf der Bestands-DB fehlgeschlagen"
ON41A=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*)::text || '|' || min(\"untdidCode\") || '|' || bool_and(\"isSystem\")::text from \"PaymentMethod\" where \"orgId\"='org41a' and code='ONLINE'")
[ "$ON41A" = "1|68|true" ] || fail "Zahlungsart ONLINE bei org41a falsch ('$ON41A'), erwartet 1|68|true"
ON41B=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*)::text || '|' || min(name) || '|' || bool_and(\"isSystem\")::text from \"PaymentMethod\" where \"orgId\"='org41b' and code='ONLINE'")
[ "$ON41B" = "1|Eigene Online-Art|false" ] || fail "Eigene Zahlungsart ONLINE bei org41b veraendert ('$ON41B')"
NEW41=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from \"Customer\" where id='cust41a' and \"onlinePaymentProvider\" is null")
[ "$NEW41" = "1" ] || fail "neue Kundenspalte onlinePaymentProvider nicht NULL"
NEWPM41=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from \"PaymentMethod\" where \"onlineProvider\" is not null")
[ "$NEWPM41" = "0" ] || fail "neue Spalte onlineProvider nicht NULL auf Bestand"
for NT in ONLINE_OVERPAYMENT ONLINE_PAYMENT_ISSUE; do
  N41=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from \"NotificationSettings\" where \"orgId\"='org41a' and \"enabledTypesJson\" like '%\"$NT\"%'")
  [ "$N41" = "1" ] || fail "Benachrichtigungstyp $NT fehlt bei org41a"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL' || fail "Konto, Bezahllink, Vorgaenge und Ereignis nicht einfuegbar"
INSERT INTO "PaymentProviderAccount" ("id","orgId","provider","webhookPathId","updatedAt")
  VALUES ('acc41a','org41a','MOLLIE','wh41a',NOW());
INSERT INTO "InvoicePayLink" ("id","orgId","invoiceId","provider","tokenHash","tokenEnc","createdBy")
  VALUES ('pl41a','org41a','inv41a','MOLLIE','hash41a','enc41a','test');
INSERT INTO "PaymentProviderAttempt" ("id","orgId","payLinkId","provider","amountCents","currency","updatedAt")
  VALUES ('at41a','org41a','pl41a','MOLLIE',1000,'EUR',NOW()),
         ('at41b','org41a','pl41a','MOLLIE',1000,'EUR',NOW());
INSERT INTO "PaymentProviderEvent" ("id","orgId","provider","eventId","type","objectId","result")
  VALUES ('ev41a','org41a','MOLLIE','tr_Test41:paid','payment','tr_Test41','APPLIED');
SQL
DEF41=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select a.enabled::text || '|' || l.status || '|' || l.\"onDocument\"::text || '|' || t.status from \"PaymentProviderAccount\" a, \"InvoicePayLink\" l, \"PaymentProviderAttempt\" t where a.id='acc41a' and l.id='pl41a' and t.id='at41a'")
[ "$DEF41" = "false|ACTIVE|false|CREATING" ] || fail "Standardwerte falsch ('$DEF41'), erwartet false|ACTIVE|false|CREATING"
pg_expect_error 'duplicate key value violates unique constraint "PaymentProviderAccount_orgId_provider_key"' "Zweites Konto je (Organisation, Anbieter) wurde nicht abgewiesen" <<'SQL'
INSERT INTO "PaymentProviderAccount" ("id","orgId","provider","webhookPathId","updatedAt")
  VALUES ('acc41dup','org41a','MOLLIE','wh41dup',NOW());
SQL
pg_expect_error 'duplicate key value violates unique constraint "InvoicePayLink_invoiceId_key"' "Zweiter Bezahllink je Rechnung wurde nicht abgewiesen" <<'SQL'
INSERT INTO "InvoicePayLink" ("id","orgId","invoiceId","provider","tokenHash","tokenEnc","createdBy")
  VALUES ('pl41dup','org41a','inv41a','MOLLIE','hash41dup','enc','test');
SQL
pg_expect_error 'duplicate key value violates unique constraint "PaymentProviderEvent_provider_eventId_key"' "Doppeltes Ereignis wurde nicht abgewiesen" <<'SQL'
INSERT INTO "PaymentProviderEvent" ("id","orgId","provider","eventId","type","objectId","result")
  VALUES ('ev41dup','org41a','MOLLIE','tr_Test41:paid','payment','tr_Test41','IGNORED');
SQL
pg_expect_error 'violates foreign key constraint "PaymentProviderAttempt_orgId_fkey"' "Bezahlvorgang mit unbekannter Organisation wurde nicht abgewiesen" <<'SQL'
INSERT INTO "PaymentProviderAttempt" ("id","orgId","payLinkId","provider","amountCents","currency","updatedAt")
  VALUES ('at41x','org41zz','pl41a','MOLLIE',1000,'EUR',NOW());
SQL
pg_expect_error 'violates foreign key constraint "PaymentProviderEvent_orgId_fkey"' "Ereignis mit unbekannter Organisation wurde nicht abgewiesen" <<'SQL'
INSERT INTO "PaymentProviderEvent" ("id","orgId","provider","eventId","type","objectId","result")
  VALUES ('ev41x','org41zz','MOLLIE','tr_Test41x:paid','payment','tr_Test41x','IGNORED');
SQL
pg_expect_error 'violates foreign key constraint "InvoicePayLink_invoiceId_fkey"' "Rechnung mit Bezahllink wurde geloescht (RESTRICT erwartet)" <<'SQL'
DELETE FROM "Invoice" WHERE id='inv41a';
SQL
CT41=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select data_type from information_schema.columns where table_schema='public' and table_name='PaymentProviderAccount' and column_name='enabled'")
[ "$CT41" = "boolean" ] || fail "enabled hat Typ '$CT41', erwartet boolean"
COUNT41=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT41" = "$TABLES_EXPECTED" ] || fail "erwartet $TABLES_EXPECTED Tabellen nach Zahlungsanbieter, gefunden $COUNT41"
echo "    ok — Zahlungsart ONLINE je Organisation (eigene bleibt), beide Benachrichtigungstypen ergaenzt, neue Spalten NULL, Konto/Link/Vorgaenge mit Standardwerten, Unique-Verletzungen und Rechnung mit Link nicht loeschbar, enabled boolean, ${TABLES_EXPECTED} Tabellen"

echo "==> Fall 42: Stripe — Zahlungsreferenz am Vorgang, Live-Kennzeichen am Bezahllink"
# Praeambel wie Fall 41, Ausschluss nur der Stripe-Migration. Bestand: Organisation, Kunde, Rechnung, Bezahllink, Vorgang.
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20261126090100_stripe|20261127090100_datev|20261128090100_pflichtpruefungen|20261129090100_eingangsrechnungen|20261130090100_eingang_ablauf)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org42a','Bestand Zweiundvierzig GmbH','Weg 42','99942','Bestadt',NOW());
INSERT INTO "Customer" ("id","orgId","name","addressLine1","postalCode","city","countryCode","updatedAt")
  VALUES ('cust42a','org42a','Zweiundvierzig-Kunde GmbH','Kundenweg 42','99942','Bestadt','DE',NOW());
INSERT INTO "Invoice" ("id","orgId","customerId","number","status","updatedAt")
  VALUES ('inv42a','org42a','cust42a','RE-2220-42001','FINALIZED',NOW());
INSERT INTO "InvoicePayLink" ("id","orgId","invoiceId","provider","tokenHash","tokenEnc","createdBy")
  VALUES ('pl42a','org42a','inv42a','MOLLIE','hash42a','enc42a','test');
INSERT INTO "PaymentProviderAttempt" ("id","orgId","payLinkId","provider","providerObjectId","amountCents","currency","updatedAt")
  VALUES ('at42a','org42a','pl42a','MOLLIE','tr_Test42a',1000,'EUR',NOW());
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Stripe-Migration ist auf der Bestands-DB fehlgeschlagen"
LIVE42=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"liveIssued\"::text from \"InvoicePayLink\" where id='pl42a'")
[ "$LIVE42" = "true" ] || fail "Bestands-Bezahllink hat liveIssued '$LIVE42', erwartet true"
REF42=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from \"PaymentProviderAttempt\" where id='at42a' and \"providerPaymentRef\" is null")
[ "$REF42" = "1" ] || fail "providerPaymentRef beim Bestandsvorgang nicht NULL"
LT42=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select data_type from information_schema.columns where table_schema='public' and table_name='InvoicePayLink' and column_name='liveIssued'")
[ "$LT42" = "boolean" ] || fail "liveIssued hat Typ '$LT42', erwartet boolean"
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL' || fail "Zwei Vorgaenge mit NULL-Zahlungsreferenz nicht einfuegbar"
INSERT INTO "PaymentProviderAttempt" ("id","orgId","payLinkId","provider","amountCents","currency","updatedAt")
  VALUES ('at42b','org42a','pl42a','STRIPE',1000,'EUR',NOW()),
         ('at42c','org42a','pl42a','STRIPE',1000,'EUR',NOW());
UPDATE "PaymentProviderAttempt" SET "providerPaymentRef"='pi_Test42' WHERE id='at42b';
SQL
pg_expect_error 'duplicate key value violates unique constraint "PaymentProviderAttempt_provider_providerPaymentRef_key"' "Gleiche Zahlungsreferenz je Anbieter wurde nicht abgewiesen" <<'SQL'
UPDATE "PaymentProviderAttempt" SET "providerPaymentRef"='pi_Test42' WHERE id='at42c';
SQL
COUNT42=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT42" = "$TABLES_EXPECTED" ] || fail "erwartet $TABLES_EXPECTED Tabellen nach Stripe, gefunden $COUNT42"
echo "    ok — Bestandslink liveIssued true (boolean), Zahlungsreferenz NULL, mehrere NULL erlaubt, doppelte Referenz je Anbieter scheitert (unique), ${TABLES_EXPECTED} Tabellen"

echo "==> Fall 43: DATEV — Einstellungen, Kontenzuordnung, Exportprotokoll, Debitorennummer"
# Praeambel wie Fall 42, Ausschluss nur der DATEV-Migration. Bestand: zwei Organisationen (Benachrichtigungstypen), Kunde.
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20261127090100_datev|20261128090100_pflichtpruefungen|20261129090100_eingangsrechnungen|20261130090100_eingang_ablauf)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org43a','Bestand Dreiundvierzig GmbH','Weg 43','99943','Bestadt',NOW()),
         ('org43b','Bestand Dreiundvierzig Zwei GmbH','Weg 44','99943','Bestadt',NOW());
INSERT INTO "Customer" ("id","orgId","name","addressLine1","postalCode","city","countryCode","updatedAt")
  VALUES ('cust43a','org43a','Dreiundvierzig-Kunde GmbH','Kundenweg 43','99943','Bestadt','DE',NOW());
INSERT INTO "NotificationSettings" ("id","orgId","enabledTypesJson","updatedAt")
  VALUES ('ns43a','org43a','["INVOICE_DUE_TODAY"]',NOW()),
         ('ns43b','org43b','[]',NOW());
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "DATEV-Migration ist auf der Bestands-DB fehlgeschlagen"
for T in DatevSettings DatevAccountMapping DatevExport DatevExportItem; do
  T43=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from information_schema.tables where table_schema='public' and table_name='$T'")
  [ "$T43" = "1" ] || fail "Tabelle $T fehlt"
done
DA43=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from \"Customer\" where id='cust43a' and \"datevAccount\" is null")
[ "$DA43" = "1" ] || fail "Customer.datevAccount nicht NULL auf Bestand"
DT43=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select data_type from information_schema.columns where table_schema='public' and table_name='Customer' and column_name='datevAccount'")
[ "$DT43" = "integer" ] || fail "datevAccount hat Typ '$DT43', erwartet integer"
for NSID in ns43a ns43b; do
  N43=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select (length(\"enabledTypesJson\") - length(replace(\"enabledTypesJson\", 'DATEV_LATE_ITEMS', ''))) / length('DATEV_LATE_ITEMS') from \"NotificationSettings\" where id='$NSID'")
  [ "$N43" = "1" ] || fail "Benachrichtigungstyp DATEV_LATE_ITEMS bei $NSID nicht genau einmal ('$N43')"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL' || fail "Debitorennummern nicht einfuegbar (gleiche Nummer in zwei Organisationen, zwei NULL)"
INSERT INTO "Customer" ("id","orgId","name","addressLine1","postalCode","city","countryCode","updatedAt","datevAccount")
  VALUES ('cust43b','org43a','Dreiundvierzig Zwei','Weg 1','99943','Bestadt','DE',NOW(),10001),
         ('cust43c','org43b','Dreiundvierzig Drei','Weg 2','99943','Bestadt','DE',NOW(),10001),
         ('cust43d','org43a','Dreiundvierzig Vier','Weg 3','99943','Bestadt','DE',NOW(),NULL);
SQL
pg_expect_error 'duplicate key value violates unique constraint "Customer_orgId_datevAccount_key"' "Doppelte Debitorennummer je Organisation wurde nicht abgewiesen" <<'SQL'
INSERT INTO "Customer" ("id","orgId","name","addressLine1","postalCode","city","countryCode","updatedAt","datevAccount")
  VALUES ('cust43e','org43a','Dreiundvierzig Fuenf','Weg 4','99943','Bestadt','DE',NOW(),10001);
SQL
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL' || fail "Einstellung, Zuordnung und Export nicht einfuegbar"
INSERT INTO "DatevSettings" ("id","orgId","updatedAt") VALUES ('ds43a','org43a',NOW());
INSERT INTO "DatevAccountMapping" ("id","orgId","kind","key","account","updatedAt")
  VALUES ('dm43a','org43a','REVENUE','REGULAR|S|19',8400,NOW());
INSERT INTO "DatevExport" ("id","orgId","mode","fromMonth","toMonth","lineCount","itemCount","manualCount","debtorCount","sha256","archivePath","filesJson","settingsJson","createdBy")
  VALUES ('de43a','org43a','PERIOD','2096-01','2096-01',1,1,0,1,'sha43','datev/x.zip','[]','{}','test');
INSERT INTO "DatevExportItem" ("id","orgId","exportId","itemKey","month","status","lineCount","amountCents")
  VALUES ('di43a','org43a','de43a','doc:inv43a','2096-01','EXPORTED',1,11900);
SQL
DEF43=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"accountLength\"::text || '|' || \"debtorMode\" || '|' || \"lockBatch\"::text || '|' || \"exportPayments\"::text from \"DatevSettings\" where id='ds43a'")
[ "$DEF43" = "4|PERSONAL|false|false" ] || fail "DatevSettings-Standardwerte falsch ('$DEF43')"
SINCE43=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select data_type || '|' || is_nullable from information_schema.columns where table_schema='public' and table_name='DatevSettings' and column_name='exportPaymentsSince'")
[ "$SINCE43" = "timestamp without time zone|YES" ] || fail "DatevSettings.exportPaymentsSince hat Typ '$SINCE43', erwartet timestamp NULL"
SINCEV43=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from \"DatevSettings\" where id='ds43a' and \"exportPaymentsSince\" is null")
[ "$SINCEV43" = "1" ] || fail "DatevSettings.exportPaymentsSince ist nicht NULL in der Standardzeile"
pg_expect_error 'duplicate key value violates unique constraint "DatevSettings_orgId_key"' "Zweite DatevSettings je Organisation wurde nicht abgewiesen" <<'SQL'
INSERT INTO "DatevSettings" ("id","orgId","updatedAt") VALUES ('ds43b','org43a',NOW());
SQL
pg_expect_error 'duplicate key value violates unique constraint "DatevAccountMapping_orgId_kind_key_key"' "Doppelte Kontenzuordnung wurde nicht abgewiesen" <<'SQL'
INSERT INTO "DatevAccountMapping" ("id","orgId","kind","key","account","updatedAt")
  VALUES ('dm43b','org43a','REVENUE','REGULAR|S|19',8401,NOW());
SQL
pg_expect_error 'violates foreign key constraint "DatevExportItem_exportId_fkey"' "Position ohne Export wurde nicht abgewiesen" <<'SQL'
INSERT INTO "DatevExportItem" ("id","orgId","exportId","itemKey","month","status","lineCount","amountCents")
  VALUES ('di43b','org43a','gibt-es-nicht','doc:x','2096-01','EXPORTED',1,1);
SQL
pg_expect_error 'violates foreign key constraint "DatevExportItem_exportId_fkey"' "Export mit Positionen wurde loeschbar (erwartet: Restrict)" <<'SQL'
DELETE FROM "DatevExport" WHERE id='de43a';
SQL
COUNT43=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT43" = "$TABLES_EXPECTED" ] || fail "erwartet $TABLES_EXPECTED Tabellen nach DATEV, gefunden $COUNT43"
echo "    ok — vier Tabellen, datevAccount NULL (integer) auf Bestand, Benachrichtigungstyp je Organisation genau einmal, Debitorennummer je Organisation eindeutig (zwei Organisationen und zwei NULL ok), Einstellungs-Standardwerte 4|PERSONAL|false|false, Unique- und Restrict-Regeln greifen, ${TABLES_EXPECTED} Tabellen"

echo "==> Fall 44: Pflichtpruefungen — Umsatzgrenzen-Einstellungen, Verzugshinweis am Beleg, Benachrichtigungstyp"
# Praeambel wie Fall 43, Ausschluss nur der neuen Migration. Bestand: zwei Organisationen, Kunde, festgeschriebene Rechnung.
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20261128090100_pflichtpruefungen|20261129090100_eingangsrechnungen|20261130090100_eingang_ablauf)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org44a','Bestand Vierundvierzig GmbH','Weg 44','99944','Bestadt',NOW()),
         ('org44b','Bestand Vierundvierzig Zwei GmbH','Weg 45','99944','Bestadt',NOW());
INSERT INTO "Customer" ("id","orgId","name","addressLine1","postalCode","city","countryCode","updatedAt")
  VALUES ('cust44a','org44a','Vierundvierzig-Kunde GmbH','Kundenweg 44','99944','Bestadt','DE',NOW());
INSERT INTO "Invoice" ("id","orgId","customerId","number","status","updatedAt")
  VALUES ('inv44a','org44a','cust44a','RE-2232-44001','FINALIZED',NOW());
INSERT INTO "DocumentSettings" ("id","orgId","updatedAt") VALUES ('dset44a','org44a',NOW());
INSERT INTO "NotificationSettings" ("id","orgId","enabledTypesJson","updatedAt")
  VALUES ('ns44a','org44a','["INVOICE_OVERDUE"]',NOW()),
         ('ns44b','org44b','[]',NOW());
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Migration Pflichtpruefungen ist auf der Bestands-DB fehlgeschlagen"
DS44=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"kuWarnPercent\"::text || '|' || coalesce(\"kuBusinessStartYear\"::text, 'NULL') || '|' || \"kuExternalRevenueJson\" || '|' || \"consumerDefaultNotice\"::text from \"DocumentSettings\" where id='dset44a'")
[ "$DS44" = "80|NULL|{}|false" ] || fail "Bestands-DocumentSettings hat '$DS44', erwartet 80|NULL|{}|false"
INV44=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from \"Invoice\" where id='inv44a' and \"consumerDefaultNotice\" is null")
[ "$INV44" = "1" ] || fail "Invoice.consumerDefaultNotice beim Bestandsbeleg nicht NULL"
for COL44 in "DocumentSettings|consumerDefaultNotice|boolean|NO" "Invoice|consumerDefaultNotice|boolean|YES" "DocumentSettings|kuWarnPercent|integer|NO" "DocumentSettings|kuBusinessStartYear|integer|YES"; do
  IFS='|' read -r TBL44 CN44 DT44 NL44 <<<"$COL44"
  T44=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select data_type || '|' || is_nullable from information_schema.columns where table_schema='public' and table_name='$TBL44' and column_name='$CN44'")
  [ "$T44" = "$DT44|$NL44" ] || fail "$TBL44.$CN44 hat '$T44', erwartet $DT44|$NL44"
done
NT44=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select string_agg(\"enabledTypesJson\", ';' order by id) from \"NotificationSettings\" where id in ('ns44a','ns44b')")
[ "$NT44" = '["INVOICE_OVERDUE","KU_THRESHOLD","INCOMING_DUE"];["KU_THRESHOLD","INCOMING_DUE"]' ] || fail "enabledTypesJson nach Migration '$NT44'"
COUNT44=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT44" = "$TABLES_EXPECTED" ] || fail "erwartet $TABLES_EXPECTED Tabellen nach Pflichtpruefungen, gefunden $COUNT44"
echo "    ok — Bestandszeile 80|NULL|{}|false (boolean), Beleg-Verzugshinweis NULL, Benachrichtigungstyp je Organisation ergaenzt, ${TABLES_EXPECTED} Tabellen"

echo "==> Fall 45: Eingangsrechnungen — Tabellen, Eindeutigkeit je Org, Loeschschutz"
# Praeambel wie Fall 44, Ausschluss nur der neuen Migration. Bestand: zwei Organisationen.
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20261129090100_eingangsrechnungen|20261130090100_eingang_ablauf)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org45a','Bestand Fuenfundvierzig GmbH','Weg 45','99945','Bestadt',NOW()),
         ('org45b','Bestand Fuenfundvierzig Zwei GmbH','Weg 46','99945','Bestadt',NOW());
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Migration Eingangsrechnungen ist auf der Bestands-DB fehlgeschlagen"
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL' \
  || fail "Eingangsrechnung je Organisation mit gleichem Hash nicht anlegbar"
INSERT INTO "IncomingInvoice" ("id","orgId","receivedAt","channel","originalFileName","originalMime","originalSize","originalSha256","originalPath","kind","createdBy","updatedAt")
  VALUES ('in45a','org45a',NOW(),'UPLOAD','a.xml','application/xml',10,'hash45','incoming/a','EINVOICE','test',NOW()),
         ('in45b','org45b',NOW(),'UPLOAD','a.xml','application/xml',10,'hash45','incoming/b','EINVOICE','test',NOW());
INSERT INTO "IncomingInvoiceValidation" ("id","incomingInvoiceId","engine","artefactVersion","result")
  VALUES ('iv45a','in45a','test','1','VALID');
SQL
if docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q >/dev/null 2>&1 <<'SQL'
INSERT INTO "IncomingInvoice" ("id","orgId","receivedAt","channel","originalFileName","originalMime","originalSize","originalSha256","originalPath","kind","createdBy","updatedAt")
  VALUES ('in45c','org45a',NOW(),'UPLOAD','b.xml','application/xml',10,'hash45','incoming/c','EINVOICE','test',NOW());
SQL
then fail "gleicher Hash in derselben Organisation wurde angenommen"; fi
if docker exec "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q -c "DELETE FROM \"IncomingInvoice\" WHERE id='in45a'" >/dev/null 2>&1; then
  fail "Eingangsrechnung mit Pruefergebnis liess sich loeschen"
fi
for COL45 in "IncomingInvoice|isEInvoice|boolean|NO" "IncomingInvoice|receivedAt|timestamp without time zone|NO" "IncomingInvoice|netCents|integer|YES" "IncomingInvoiceValidation|at|timestamp without time zone|NO"; do
  IFS='|' read -r TBL45 CN45 DT45 NL45 <<<"$COL45"
  T45=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select data_type || '|' || is_nullable from information_schema.columns where table_schema='public' and table_name='$TBL45' and column_name='$CN45'")
  [ "$T45" = "$DT45|$NL45" ] || fail "$TBL45.$CN45 hat '$T45', erwartet $DT45|$NL45"
done
for IDX45 in IncomingInvoice_orgId_validationStatus_idx IncomingInvoice_duplicateOfId_idx IncomingInvoice_orgId_number_idx IncomingInvoice_validationStatus_receivedAt_idx; do
  [ "$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from pg_indexes where schemaname='public' and indexname='$IDX45'")" = "1" ] || fail "Index $IDX45 fehlt"
done
COUNT45=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT45" = "$TABLES_EXPECTED" ] || fail "erwartet $TABLES_EXPECTED Tabellen nach Eingangsrechnungen, gefunden $COUNT45"
echo "    ok — Hash je Organisation eindeutig, Loeschen mit Pruefergebnis abgewiesen, ${TABLES_EXPECTED} Tabellen"

echo "==> Fall 46: Eingangsrechnungen Arbeitsablauf — Spalten, Faelligkeit aus Bestand, Benachrichtigungstyp"
# Praeambel wie Fall 45, Ausschluss nur der neuen Migration. Bestand: zwei Organisationen (Benachrichtigungstypen), zwei Eingangsrechnungen.
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20261130090100_eingang_ablauf)$' | sort); do
  apply_and_mark "$MIG"
done
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org46','Bestand Sechsundvierzig GmbH','Weg 46','99946','Bestadt',NOW()),
         ('org46b','Bestand Sechsundvierzig Zwei GmbH','Weg 47','99946','Bestadt',NOW());
INSERT INTO "NotificationSettings" ("id","orgId","enabledTypesJson","updatedAt")
  VALUES ('ns46a','org46','["INVOICE_OVERDUE"]',NOW()),
         ('ns46b','org46b','[]',NOW());
INSERT INTO "IncomingInvoice" ("id","orgId","receivedAt","channel","originalFileName","originalMime","originalSize","originalSha256","originalPath","kind","dueDate","createdBy","updatedAt")
  VALUES ('in46a','org46',NOW(),'UPLOAD','a.xml','application/xml',10,'hash46a','incoming/a','EINVOICE','2026-12-01 00:00:00','test',NOW()),
         ('in46b','org46',NOW(),'UPLOAD','b.png','image/png',10,'hash46b','incoming/b','OTHER',NULL,'test',NOW());
SQL
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "Migration Eingangsrechnungen Arbeitsablauf ist auf der Bestands-DB fehlgeschlagen"
D46=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select ('in46a' || '|' || (\"dueAt\" = \"dueDate\")::text || '|' || status) from \"IncomingInvoice\" where id='in46a'")
[ "$D46" = "in46a|true|NEW" ] || fail "Faelligkeit aus Bestand '$D46'"
B46=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select ((\"dueAt\" IS NULL)::text || '|' || status) from \"IncomingInvoice\" where id='in46b'")
[ "$B46" = "true|NEW" ] || fail "Eingang ohne Faelligkeit '$B46'"
NT46=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select string_agg(\"enabledTypesJson\", ';' order by id) from \"NotificationSettings\" where id in ('ns46a','ns46b')")
[ "$NT46" = '["INVOICE_OVERDUE","INCOMING_DUE"];["INCOMING_DUE"]' ] || fail "enabledTypesJson nach Migration '$NT46'"
for COL46 in "IncomingInvoice|dueAt|timestamp without time zone|YES" "IncomingInvoice|paidMarkedAt|timestamp without time zone|YES" "IncomingInvoice|internalNote|text|YES" "IncomingInvoice|supplierContactId|text|YES"; do
  IFS='|' read -r TBL46 CN46 DT46 NL46 <<<"$COL46"
  T46=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select data_type || '|' || is_nullable from information_schema.columns where table_schema='public' and table_name='$TBL46' and column_name='$CN46'")
  [ "$T46" = "$DT46|$NL46" ] || fail "$TBL46.$CN46 hat '$T46', erwartet $DT46|$NL46"
done
for IDX46 in IncomingInvoice_orgId_status_dueAt_idx IncomingInvoice_orgId_supplierContactId_idx; do
  [ "$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from pg_indexes where schemaname='public' and indexname='$IDX46'")" = "1" ] || fail "Index $IDX46 fehlt"
done
COUNT46=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT46" = "$TABLES_EXPECTED" ] || fail "erwartet $TABLES_EXPECTED Tabellen nach Arbeitsablauf, gefunden $COUNT46"
echo "    ok — Faelligkeit aus Bestand uebernommen, Status unveraendert, Benachrichtigungstyp ergaenzt, ${TABLES_EXPECTED} Tabellen"

echo "ALLE TESTS BESTANDEN"
