/**
 * Phase 16a, Task 8 — Betriebsskripte: Syntax und Eingabepruefung (ohne Datenbank/Docker).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, mkdirSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BACKUP = path.resolve("scripts/ops/backup.sh");
const RESTORE = path.resolve("scripts/ops/restore-test.sh");

let dir: string;
let pass600: string;
let pass644: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "oig-ops-"));
  pass600 = path.join(dir, "p600");
  pass644 = path.join(dir, "p644");
  writeFileSync(pass600, "geheim\n");
  chmodSync(pass600, 0o600);
  writeFileSync(pass644, "geheim\n");
  chmodSync(pass644, 0o644);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(script: string, env: Record<string, string>, args: string[] = []) {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith("BACKUP_") || k === "DATABASE_URL") delete base[k];
  return spawnSync("bash", [script, ...args], { env: { ...base, ...env }, encoding: "utf8" });
}
function lastLine(out: string): string {
  return out.trim().split("\n").pop() ?? "";
}

describe("Betriebsskripte", () => {
  it.each([BACKUP, RESTORE])("bash -n %s Exit 0", (script) => {
    expect(spawnSync("bash", ["-n", script]).status).toBe(0);
  });

  it("backup.sh: unbekanntes Ziel ftp:x -> FEHLER, Exit != 0", () => {
    const r = run(BACKUP, { BACKUP_PASSPHRASE_FILE: pass600, BACKUP_TARGET: "ftp:x", DATABASE_URL: "postgresql://x" });
    expect(r.status).not.toBe(0);
    expect(lastLine(r.stdout)).toMatch(/^FEHLER /);
  });

  it("backup.sh: Passphrasen-Datei Modus 644 -> FEHLER, Exit != 0", () => {
    const r = run(BACKUP, { BACKUP_PASSPHRASE_FILE: pass644, DATABASE_URL: "postgresql://x" });
    expect(r.status).not.toBe(0);
    expect(lastLine(r.stdout)).toMatch(/^FEHLER .*600/);
  });

  it("backup.sh: fehlende Passphrasen-Datei -> FEHLER und Status-Zeile", () => {
    const status = path.join(dir, "status.txt");
    const r = run(BACKUP, { BACKUP_STATUS_FILE: status, DATABASE_URL: "postgresql://x" });
    expect(r.status).not.toBe(0);
    expect(lastLine(r.stdout)).toMatch(/^FEHLER /);
    const written = spawnSync("cat", [status], { encoding: "utf8" }).stdout;
    expect(written).toMatch(/^FEHLER \d{4}-\d{2}-\d{2}T/);
  });

  it("backup.sh: BACKUP_KEEP_REMOTE keine Ganzzahl -> FEHLER", () => {
    const r = run(BACKUP, { BACKUP_PASSPHRASE_FILE: pass600, DATABASE_URL: "postgresql://x", BACKUP_KEEP_REMOTE: "1; rm -rf /" });
    expect(r.status).not.toBe(0);
    expect(lastLine(r.stdout)).toMatch(/^FEHLER .*Ganzzahl/);
  });

  it("backup.sh: pg_dump nur mit Optionen (keine URL in argv), umask 077", () => {
    const src = readFileSync(BACKUP, "utf8");
    expect(src).toContain("pg_dump --no-owner --no-privileges | gzip");
    expect(src).toContain("umask 077");
    expect(src).not.toMatch(/pg_dump[^\n]*\$(DATABASE_URL|PG_URL)/);
  });

  it("restore-test.sh: ohne Argument -> FEHLER", () => {
    const r = run(RESTORE, { BACKUP_PASSPHRASE_FILE: pass600 });
    expect(r.status).not.toBe(0);
    expect(lastLine(r.stdout)).toMatch(/^FEHLER /);
  });
});

describe("backup.sh mit Stub-pg_dump", () => {
  function setup(dump: string) {
    const root = mkdtempSync(path.join(dir, "stub-"));
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    const argvLog = path.join(root, "argv.txt");
    const pwLog = path.join(root, "pw.txt");
    writeFileSync(path.join(root, "dump.sql"), dump);
    writeFileSync(
      path.join(bin, "pg_dump"),
      `#!/bin/sh\necho "$@" > "${argvLog}"\nprintf '%s' "$PGPASSWORD" > "${pwLog}"\nprintf '%s|%s|%s|%s|%s' "$PGHOST" "$PGPORT" "$PGDATABASE" "$PGUSER" "$PGSSLMODE" > "${argvLog}.env"\ncat "${root}/dump.sql"\n`,
    );
    chmodSync(path.join(bin, "pg_dump"), 0o755);
    const backups = path.join(root, "backups");
    return { root, bin, argvLog, pwLog, backups };
  }
  const fullDump = ["Invoice", "Payment", "ChangeLog", "ArchivedDocument", "Dunning"]
    .map((t, i) => `COPY public."${t}" (id) FROM stdin;\n${"x\n".repeat(i)}\\.\n`)
    .join("\n");

  function runStub(st: ReturnType<typeof setup>, url: string) {
    return run(BACKUP, {
      PATH: `${st.bin}:${process.env.PATH ?? ""}`,
      BACKUP_PASSPHRASE_FILE: pass600,
      BACKUP_DIR: st.backups,
      DATABASE_URL: url,
      ATTACHMENTS_DIR: path.join(st.root, "att"),
      ARCHIVE_DIR: path.join(st.root, "arc"),
      ENV_FILE: path.join(st.root, "none.env"),
    });
  }

  it("Passwort mit rohem @ und %-Kodierung: argv nur Optionen, Verbindung per PG*-Umgebung", () => {
    const st = setup(fullDump);
    const r = runStub(st, "postgresql://oig:p@ss%25w@db:5432/openinvoice?schema=public&sslmode=require");
    expect(lastLine(r.stdout)).toMatch(/^OK /);
    const argv = readFileSync(st.argvLog, "utf8").trim();
    expect(argv).toBe("--no-owner --no-privileges");
    expect(argv).not.toContain("@");
    expect(argv).not.toContain("db");
    expect(readFileSync(st.pwLog, "utf8")).toBe("p@ss%w");
    expect(readFileSync(`${st.argvLog}.env`, "utf8")).toBe("db|5432|openinvoice|oig|require");
    expect(readdirSync(st.backups).filter((f) => f.endsWith(".tar.enc"))).toHaveLength(1);
  });

  it("prozent-kodiertes / ? # im Passwort und IPv6-Host werden korrekt dekodiert", () => {
    const st = setup(fullDump);
    const r = runStub(st, "postgresql://o%40ig:ge%2Fh%3Fe%23im@[::1]:6543/my%20db");
    expect(lastLine(r.stdout)).toMatch(/^OK /);
    expect(readFileSync(st.argvLog, "utf8").trim()).toBe("--no-owner --no-privileges");
    expect(readFileSync(st.pwLog, "utf8")).toBe("ge/h?e#im");
    expect(readFileSync(`${st.argvLog}.env`, "utf8")).toBe("::1|6543|my db|o@ig|");
  });

  it.each([
    "postgresql://oig:ge/heim@db:5432/openinvoice",
    "postgresql://oig:ge?heim@db:5432/openinvoice",
    "postgresql://oig:ge#heim@db:5432/openinvoice",
  ])("rohes / ? # im Passwort -> FEHLER mit Hinweis auf Prozent-Kodierung, pg_dump nie aufgerufen (%s)", (url) => {
    const st = setup(fullDump);
    const r = runStub(st, url);
    expect(r.status).not.toBe(0);
    expect(lastLine(r.stdout)).toMatch(/^FEHLER .*prozent-kodieren/);
    expect(() => readFileSync(st.argvLog)).toThrow();
  });

  it("nicht zerlegbare URL -> FEHLER, pg_dump nie aufgerufen", () => {
    const st = setup(fullDump);
    const r = runStub(st, "mysql://oig:geheim@db/x");
    expect(r.status).not.toBe(0);
    expect(lastLine(r.stdout)).toMatch(/^FEHLER /);
    expect(() => readFileSync(st.argvLog)).toThrow();
  });

  it("fehlende erwartete Tabelle im Dump -> FEHLER statt 0", () => {
    const st = setup(fullDump.replace(/COPY public\."Dunning"[\s\S]*$/, ""));
    const r = runStub(st, "postgresql://oig@db/x");
    expect(r.status).not.toBe(0);
    expect(lastLine(r.stdout)).toMatch(/^FEHLER .*Tabelle/);
    expect(() => readdirSync(st.backups).some((f) => f.endsWith(".tar.enc")) || (() => { throw new Error(); })()).toThrow();
  });
});


describe("backup.sh mit PG_DUMP_CONTAINER (pg_dump im DB-Container)", () => {
  it("ruft docker exec -e PG* <container> pg_dump nur mit Optionen auf, Passwort/URL nicht in argv", () => {
    const root = mkdtempSync(path.join(dir, "dc-"));
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    const argvLog = path.join(root, "argv.txt");
    const pwLog = path.join(root, "pw.txt");
    const dump = ["Invoice", "Payment", "ChangeLog", "ArchivedDocument", "Dunning"].map((t) => `COPY public."${t}" (id) FROM stdin;\n\\.\n`).join("\n");
    writeFileSync(path.join(root, "dump.sql"), dump);
    writeFileSync(path.join(bin, "docker"), `#!/bin/sh\necho "$@" > "${argvLog}"\nprintf '%s' "$PGPASSWORD" > "${pwLog}"\ncat "${root}/dump.sql"\n`);
    // pg_dump muss auf dem Host nicht vorhanden sein.
    chmodSync(path.join(bin, "docker"), 0o755);
    const r = run(BACKUP, {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      BACKUP_PASSPHRASE_FILE: pass600,
      BACKUP_DIR: path.join(root, "backups"),
      DATABASE_URL: "postgresql://oig:ge%2Fheim@db:5432/openinvoice",
      PG_DUMP_CONTAINER: "oig-db-1",
      ATTACHMENTS_DIR: path.join(root, "att"),
      ARCHIVE_DIR: path.join(root, "arc"),
      ENV_FILE: path.join(root, "none.env"),
    });
    expect(lastLine(r.stdout)).toMatch(/^OK /);
    const argv = readFileSync(argvLog, "utf8");
    expect(argv.trim()).toBe("exec -i -e PGHOST -e PGPORT -e PGDATABASE -e PGUSER -e PGPASSWORD oig-db-1 pg_dump --no-owner --no-privileges");
    expect(argv).not.toContain("heim");
    expect(argv).not.toContain("@");
    expect(readFileSync(pwLog, "utf8")).toBe("ge/heim");
  });
});

describe("restore-test.sh mit Stub-docker: robustes Warten, PG_IMAGE", () => {
  function setup(readySequence: string[]) {
    const root = mkdtempSync(path.join(dir, "rt-"));
    const bin = path.join(root, "bin");
    const payload = path.join(root, "payload");
    mkdirSync(bin);
    mkdirSync(path.join(payload, "arc"), { recursive: true });
    writeFileSync(path.join(payload, "db.sql"), "select 1;\n");
    spawnSync("gzip", [path.join(payload, "db.sql")]);
    spawnSync("tar", ["-czf", path.join(payload, "archive.tar.gz"), "-C", path.join(payload, "arc"), "."]);
    writeFileSync(path.join(payload, "manifest.txt"), "Invoice=0\n");
    spawnSync("tar", ["-cf", path.join(root, "p.tar"), "-C", payload, "db.sql.gz", "archive.tar.gz", "manifest.txt"]);
    const backup = path.join(root, "b.tar.enc");
    spawnSync("openssl", ["enc", "-aes-256-cbc", "-pbkdf2", "-salt", "-pass", `file:${pass600}`, "-in", path.join(root, "p.tar"), "-out", backup]);
    const seq = path.join(root, "seq");
    writeFileSync(seq, readySequence.join("\n") + "\n");
    const log = path.join(root, "docker.log");
    // "select 1"-Antworten der Reihe nach aus seq; Dump-Einspielen scheitert absichtlich (Testende).
    writeFileSync(
      path.join(bin, "docker"),
      `#!/bin/bash
echo "$@" >> "${log}"
case "$1" in
  run) echo cid ;;
  port) echo "127.0.0.1:55432" ;;
  rm) ;;
  exec)
    if [[ "$*" == *"select 1"* ]]; then
      line="$(head -n1 "${seq}")"; tail -n +2 "${seq}" > "${seq}.t"; mv "${seq}.t" "${seq}"
      [ "$line" = "1" ] && { echo 1; exit 0; }
      exit 2
    fi
    cat >/dev/null; exit 1 ;;
esac
`,
    );
    chmodSync(path.join(bin, "docker"), 0o755);
    writeFileSync(path.join(bin, "sha256sum"), "#!/bin/sh\nshasum -a 256 \"$@\"\n");
    chmodSync(path.join(bin, "sha256sum"), 0o755);
    return { root, bin, backup, log };
  }

  it("einmal flackernde Bereitschaft: wartet auf 3 Erfolge in Folge, nutzt PG_IMAGE", () => {
    const st = setup(["1", "", "1", "1", "1"]);
    const r = run(RESTORE, { PATH: `${st.bin}:${process.env.PATH ?? ""}`, BACKUP_PASSPHRASE_FILE: pass600, PG_IMAGE: "postgres:16.4" }, [st.backup]);
    // Bis zum Einspielen gekommen (der Stub laesst das absichtlich scheitern).
    expect(lastLine(r.stdout)).toBe("FEHLER Einspielen des Dumps fehlgeschlagen");
    const log = readFileSync(st.log, "utf8");
    expect(log).toMatch(/^run .* postgres:16\.4$/m);
    expect(log.match(/select 1/g)).toHaveLength(5);
    expect(log).toMatch(/psql -h 127\.0\.0\.1 /);
  }, 30_000);

  it("nie stabil bereit: FEHLER nach RESTORE_READY_TIMEOUT, Container wird entfernt", () => {
    const st = setup(Array.from({ length: 50 }, () => ""));
    const r = run(RESTORE, { PATH: `${st.bin}:${process.env.PATH ?? ""}`, BACKUP_PASSPHRASE_FILE: pass600, RESTORE_READY_TIMEOUT: "2" }, [st.backup]);
    expect(r.status).not.toBe(0);
    expect(lastLine(r.stdout)).toMatch(/^FEHLER temporaere Datenbank nicht bereit/);
    const log = readFileSync(st.log, "utf8");
    expect(log).toMatch(/^run .* postgres:16$/m);
    expect(log).toMatch(/^rm -f /m);
  }, 30_000);
});
