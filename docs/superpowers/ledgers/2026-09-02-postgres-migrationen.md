# SDD ledger — plan: /tmp/claude-501/-Users-christophersakel-PhpstormProjects-PH-invoice/333a4b59-16db-4bc4-8c3d-9b65d3087ff1/scratchpad/plan/2026-09-02-postgres-migrationen.md

## Pre-Flight-Scan

Spec gelesen: docs/superpowers/specs/2026-09-02-postgres-migrationen-design.md (via scratchpad-Kopie).

### Task-Paare mit gemeinsamen Dateien/Schnittstellen

| Paare | erzeugt → konsumiert | Befund |
|---|---|---|
| T1 ↔ T2 | `scripts/test-postgres-migrations.sh`: T1 legt an, T2 erweitert | ok — T2 fügt vor der Abschlusszeile ein, Variablen (`$CONTAINER`, `fail()`) aus T1 vorhanden |
| T1 → T2 | `prisma.postgres.config.ts` → `docker-entrypoint.sh` | ok — Pfad identisch |
| T1 → T3 | `prisma.postgres.config.ts` → `db:migrate:pg` | ok — Pfad identisch |
| T1,T2 → T4 | `scripts/test-postgres-migrations.sh` → CI-Job | ok — Pfad identisch |
| T1 → T4 | Schema-Gleichheit → `schema-drift`-Job | ok — T1 stellt sie her |
| T1 → T5 | Config-Pfad → resolve-Befehl in der Doku | ok — Pfad identisch |

### Selbstkonsistenz je Task

| Task | Befund |
|---|---|
| T1 | ok — 14 Modelle + `_prisma_migrations` = 15 Tabellen, deckt die Testerwartung |
| T2 | **Konflikt** — Schritt 7 (`docker build`) schlägt auf diesem Branch fehl; `Dockerfile:6` enthält noch `npm ci`, der Lockfile-Bug ist hier nicht behoben |
| T2 | ok — 14 Tabellen nach `db push` (ohne `_prisma_migrations`) deckt die Testerwartung |
| T3 | ok — Schritt 2 nennt die Voraussetzung (laufender Compose-Postgres) |
| T4 | ok — nach T1 sind die Schemas deckungsgleich, Job wird grün |
| T5 | Hinweis — die README-Ergänzungen enthalten verschachtelte Code-Fences; Implementer muss den inneren Block als Inhalt einfügen, nicht als Abschluss lesen |

### Rulings

Ruling: Task 2 Schritt 7 baut das Image mit dem `npm ci`→`npm install`-Fix aus
`fix/dockerfile-build` temporär im Arbeitsbaum, verifiziert, und macht die Änderung
danach rückgängig — Grund: der Build-Bug gehört in den separaten PR, unsere
`CMD`/`COPY`-Änderung muss trotzdem in einem echten Image belegt werden —
Kosten falls falsch: die Dockerfile-Änderung ist nur inspiziert statt gebaut,
der Fehler fiele beim ersten echten Deployment auf.

Ruling: Gearbeitet wird im Haupt-Checkout auf Branch `fix/postgres-migrations`
statt in einem git-worktree — Grund: ein Worktree bräuchte eine eigene
`npm install` (587 Pakete), die Tests laufen ohne `node_modules` nicht —
Kosten falls falsch: kein paralleles Arbeiten im selben Repo möglich.

Ruling: `.superpowers/` liegt in `.git/info/exclude` statt in `.gitignore` —
Grund: `.gitignore` gehört dem Upstream und darf nicht durch Werkzeugspuren
verändert werden — Kosten falls falsch: keine, rein lokal.

## Ausführung

Task 1: dispatched (sonnet), BASE 9e6631d
Task 1: implementer DONE (commit b480729, Test "ALLE TESTS BESTANDEN", 15 Tabellen)
Task 1: Bedenken des Implementers — (a) `--config` beim `migrate diff` ergaenzt, Output
  byte-identisch gegengetestet; (b) Signoff nutzt globale Git-Identitaet. Beide an den
  Reviewer weitergereicht, nicht vorbeurteilt.
Task 1: task reviewer dispatched (sonnet), diff 9e6631d..b480729
Task 1: review clean — Spec ✅, Qualitaet freigegeben, keine Critical/Important
Task 1: minor (deferred): pg_isready-Warteschleife bricht bei Timeout ohne sprechende
  Meldung ab (faellt erst ueber set -e beim naechsten Befehl auf) — Planvorgabe, nicht
  Implementer-Entscheidung
Task 1: minor (deferred): Port 55433 und Containername hartkodiert — fuer Wegwerf-Test ok
Task 1: Signoff aus dem Diff nicht pruefbar (Grenze des Review-Pakets) — vom Controller
  per git log verifiziert, siehe oben
Task 1: complete (commits 9e6631d..b480729, review clean)
Task 2: dispatched (sonnet), BASE b480729 — mit Ruling zur temporaeren npm-install-Ersetzung
  fuer die Build-Pruefung und der Auflage, sie nicht zu committen
Task 2: implementer DONE_WITH_CONCERNS (commit e5f15d3, Tests Fall 1-3 bestanden,
  docker build mit temporaerem npm-Fix erfolgreich und zurueckgesetzt)
Task 2: Ruling: runner-Stage kopiert prisma.postgres.config.ts nicht, obwohl der
  Entrypoint sie per --config aufruft — COPY-Zeile wird ergaenzt und die Build-Pruefung
  belegt die Datei im Image — Grund: ohne sie startet der Container im echten Deployment
  nicht, und die vorhandene SQLite-Config wuerde automatisch greifen, also genau der
  Fehlerfall, gegen den dieser Task baut. Defekt stammt aus meinem Plan, nicht aus der
  Umsetzung — Kosten falls falsch: keine, die Datei ist zwingend noetig.
Task 2: Testluecke notiert — die Tests laufen im Host-Checkout, kein automatischer Test
  deckt fehlende Dateien im Image ab. Fuer das Abschluss-Review vorgemerkt.
Task 2: Fix vor dem Review erledigt (commit 5c0601f) — COPY-Zeile ergaenzt, Vorhandensein
  im gebauten Image per docker run belegt. Daher volles Task-Review ueber b480729..5c0601f
  statt scoped re-review.
Task 2: review clean — Spec ✅, Qualitaet freigegeben, keine Critical/Important.
  Reviewer hat den Abbruchpfad per Code-Trace belegt (check-baseline.sql rein lesend,
  exit 1 vor jeder Mutation) und Service-Name, Modellname und Migrationsname gegen die
  echten Dateien gegengeprueft.
Task 2: minor (deferred): Testfall 2 wuerde bei ausbleibendem Abbruch haengen statt sauber
  fehlzuschlagen (entrypoint laeuft im Vordergrund) — Planvorgabe
Task 2: minor (deferred): COPY kopiert das ganze scripts/-Verzeichnis ins Produktionsimage,
  nicht nur die zwei Laufzeitdateien — Planvorgabe
Task 2: minor (deferred): Fall 3 prueft die Remediation standalone, ohne den Entrypoint
  danach erneut end-to-end aufzurufen — Planvorgabe
Task 2: complete (commits b480729..5c0601f, review clean)
Task 3: implementer DONE (commit 8f3dbcd), db:migrate:pg gegen Wegwerf-Postgres verifiziert,
  Testmigration und Container aufgeraeumt, git status sauber
Task 3: Bedenken — CONTRIBUTING verweist auf CI-Job schema-drift, den erst Task 4 anlegt.
  Vorwaertsverweis durch die Task-Reihenfolge, kein Defekt.
Task 3: task reviewer dispatched (sonnet), diff 5c0601f..8f3dbcd
Task 3: review — Spec ✅, Qualitaet NICHT freigegeben, 1 Important
Task 3: Ruling: Important-Befund (CONTRIBUTING nennt "Compose-DB muss laufen", der
  db-Service veroeffentlicht aber keinen Port und .env.example zeigt auf SQLite) wird
  behoben, obwohl der Text so im Plan stand — Grund: nachgeprueft und zutreffend, die
  Anleitung ist wortwoertlich nicht ausfuehrbar und ginge so an den Upstream. Der Mangel
  stammt aus Plan UND Spec, beide machten dieselbe falsche Annahme —
  Kosten falls falsch: keine, die Anleitung wird nachweislich lauffaehig.
Task 3: Ruling: KEIN ports-Mapping im db-Service ergaenzen — Grund: der Service nutzt
  POSTGRES_HOST_AUTH_METHOD=trust, eine Veroeffentlichung waere ein passwortloser Postgres
  am Host, also eine Sicherheitsverschlechterung — Kosten falls falsch: Entwickler brauchen
  einen Wegwerf-Container statt des Compose-Service, ein Mehraufwand von zwei Zeilen.
Task 3: Ruling: der Minor (eingerueckte statt Fenced-Codebloecke) wird mitbehoben, weil
  derselbe Absatz ohnehin neu geschrieben wird — Kosten falls falsch: keine.
Task 3: fix round 1/5 (2 addressed, 0 open — Important zur nicht ausfuehrbaren Anleitung
  und Minor zu Codeblock-Stil; commits 8f3dbcd..db1c4ef)
Task 3: complete (commits 5c0601f..db1c4ef, review clean nach Runde 1)
Task 4: implementer DONE (commit 8026320), YAML gueltig, Schema-Diff "identisch",
  Testskript lokal gruen, Container aufgeraeumt
Task 4: Bedenken des Implementers (kein explizites prisma generate im neuen CI-Job) vom
  Controller geprueft und entkraeftet: das Testskript nutzt nur CLI-Befehle ohne Client-
  Bedarf, und npm install loest postinstall "prisma generate" aus, das dank Fallback-URL
  in prisma.config.ts auch ohne DATABASE_URL durchlaeuft.
Task 4: task reviewer dispatched (sonnet), diff db1c4ef..8026320
Task 4: review clean — Spec ✅, Qualitaet freigegeben, keine Critical/Important
Task 4: Controller-Gegenprobe: kuenstlicher Drift in schema.postgres.prisma erzeugt ->
  Drift-Befehl endet mit Exit 1; nach Wiederherstellung wieder "identisch". Der Job
  meldet also echten Drift und ist kein stummer Waechter. Ausserdem: Generator-Provider
  heisst "prisma-client" und wird von der sed-Normalisierung nicht getroffen.
Task 4: Signoff aller Branch-Commits per git log verifiziert (Reviewer konnte das aus dem
  Diff-Paket nicht sehen)
Task 4: complete (commits db1c4ef..8026320, review clean)
Task 5: implementer BLOCKED — npm test faellt (45/56), weil der generierte Prisma-Client
  gegen das Postgres-Schema erzeugt wurde. Ursache nachgeprueft: beide Schemas haben
  output = "../src/generated/prisma", und "prisma migrate dev" ruft generate auf.
  Ausgeloest durch unsere eigenen db:migrate:pg-Laeufe in Task 3.
Task 5: Ruling: db:migrate:pg bekommt ein angehaengtes "&& prisma generate", damit der
  SQLite-Client danach wiederhergestellt wird, plus ein erklaerender Satz in CONTRIBUTING —
  Grund: ohne das zerlegt der von uns dokumentierte Workflow die Testsuite jedes
  Entwicklers, der ihm folgt; das ist ein Defekt im Auslieferungsumfang, nicht nur ein
  lokales Artefakt. Ein eigener Output-Pfad fuers Postgres-Schema scheidet aus, weil
  unser eigener schema-drift-Job Zeichengleichheit beider Dateien erzwingt —
  Kosten falls falsch: ein zusaetzlicher generate-Lauf von wenigen Sekunden je Migration.
Task 5: Ruling: Regenerieren des lokalen Clients per "npx prisma generate" freigegeben —
  Grund: src/generated/ ist gitignored, keine Repo-Aenderung — Kosten falls falsch: keine.
Task 5: Ruling revidiert. Das in Schritt B angeordnete "&& prisma generate" war falsch:
  npm haengt "-- --name x" ans Ende der gesamten Skriptzeile, die Argumente landen also
  bei generate statt bei migrate dev, und migrate dev haengt an einem interaktiven Prompt.
  Vom Implementer real reproduziert (Prozessliste, exit 143). Ersetzt durch ein
  Wrapper-Skript scripts/migrate-postgres.sh, das "$@" korrekt an migrate dev durchreicht
  und danach generate aufruft — Grund: nur so bleibt der dokumentierte Aufruf mit --name
  funktionsfaehig UND der SQLite-Client wird wiederhergestellt —
  Kosten falls falsch: eine zusaetzliche kleine Datei im Repo.
Task 5: review — Spec ✅, Qualitaet freigegeben, aber 1 Important
Task 5: Ruling: Important-Befund (set -e verhindert die Client-Wiederherstellung, wenn
  migrate dev nach der internen Client-Erzeugung scheitert) geht in die Fix-Schleife,
  obwohl der Reviewer ihn als "kein Blocker" einordnet — Grund: der Fehlerpfad stellt
  exakt den Defekt wieder her, gegen den das Skript gebaut wurde, und die Reparatur ist
  ein EXIT-trap von wenigen Zeilen — Kosten falls falsch: minimal, ein trap mehr.
Task 5: fix round 1/5 (2 addressed, 0 open — EXIT-Trap und Umlaute; commits 9bf2f7e..437b0b6)
Task 5: complete (commits 8026320..437b0b6, review clean nach Runde 1)
ALLE TASKS ABGESCHLOSSEN. Branch: 8 Commits, alle DCO-signiert, Pruefkette gruen.
FINAL REVIEW (opus, resumed): Merge ja mit Auflagen.
  C1 Critical: 0_init = Head-Schema (14 Modelle); echte Bestandsinstanz hat <=12 Tabellen ->
     dokumentierter resolve verbucht falsche Baseline, App scheitert an recurringInvoiceId.
  I2: Entrypoint-Happy-Path nirgends getestet. I3: Fall 2 haengt bei Regression (kein timeout).
  I4: harte Tabellenzahlen. I5: kein Drift-Netz nach Baseline. + 5 Minors.
Ruling: Fix-Welle fuer C1, I2, I3 plus die Einzeiler (DATABASE_URL-Klartextcheck,
  pg_isready-Meldung, timeout-minutes in CI). I4 und I5 werden NICHT jetzt behoben —
  Grund: Phase-0-Plan Task 4 schreibt das Testskript ohnehin um (Legacy-DB per Baseline-SQL,
  Fall 4 Backfill) und ist der richtige Ort fuer robustere Kriterien; I5 (Drift-Warnung nach
  deploy) wird als Folgepunkt ins Backlog uebernommen — Kosten falls falsch: eine Migration
  spaeter faellt der Tabellenzahl-Check laut, aber harmlos.
Ruling: Verifikationsbefehl fuer Bestandsinstanzen = prisma migrate diff --from-url
  --to-schema-datamodel --script; leer -> resolve; nur-additiv -> per db execute anwenden,
  dann resolve; DROP -> abbrechen. Steht kuenftig in READMEs UND in der Abbruchmeldung.
FINAL fix wave: DONE (commit 5fe5db1) — C1 (Diff-Verifikation in READMEs + Abbruchmeldung),
  I2 (db-prepare.sh abgespalten, Fall 4 Happy-Path), I3 (run_with_timeout), Einzeiler.
  C1 empirisch belegt: aeltere DB nachgebaut, migrate diff liefert nur additive Anweisungen.
FINAL scoped re-review dispatched (sonnet), diff 437b0b6..5fe5db1
FINAL re-review: alle Befunde ADDRESSED, mergefaehig. Residual (README-Whitelist ohne
  ADD CONSTRAINT) — Ruling: als 2-Zeilen-Doku-Commit direkt vom Controller nachgezogen
  (kein Code, kein Review-Risiko) — Kosten falls falsch: keine.
PLAN COMPLETE: fix/postgres-migrations per ff in main gemergt und gepusht. Kein Upstream-PR
  geoeffnet (Betreiber entscheidet).
