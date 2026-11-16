/**
 * Schutz gegen Rueckschritte im Container-Image (Dockerfile + .dockerignore).
 *
 * Mehrere Routen lesen Dateien zur Laufzeit relativ zu `process.cwd()` (openapi.json,
 * PDF-Schriften, Favicon, Swagger-UI). Fehlten sie im Image, gab es auf jeder
 * Produktivinstanz 500er bzw. kaputte PDF/A-Dateien (Phase 10, Phase 14a, Fix-Welle 12c).
 * Seit 1.0.1 legt das Next.js-Tracing sie im Standalone-Output ab, und die build-Stage
 * bricht ab, wenn eine fehlt — diese Tests sichern, dass die Pruefung und die
 * Whitelist des Build-Kontexts bestehen bleiben. Die volle Verifikation (Image bauen,
 * gegen PostgreSQL starten) laeuft in .github/workflows/docker.yml.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");
const dockerfile = read("Dockerfile");
const buildStage = dockerfile.slice(dockerfile.indexOf("AS build"), dockerfile.indexOf("AS prisma-cli"));
const runnerStage = dockerfile.slice(dockerfile.indexOf("AS runner"));
const ignoreLines = read(".dockerignore")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

describe("Dockerfile", () => {
  it.each([
    "openapi/openapi.json",
    "assets/fonts/LiberationSans-Regular.ttf",
    "assets/fonts/IBMPlexSans-Regular.ttf",
    "assets/fonts/IBMPlexSerif-Regular.ttf",
    "assets/fonts/Inter-Regular.ttf",
    "assets/fonts/SourceSerif4-Regular.ttf",
    "src/app/favicon.ico",
    "src/workers/incoming-worker.mjs",
    "assets/einvoice-validation/pins.env",
    "assets/einvoice-validation/LICENSES/LICENSE-en16931-validation-EUPL-1.2.txt",
    "node_modules/swagger-ui-dist/swagger-ui-bundle.js",
    "node_modules/pdfkit/js/data/Helvetica.afm",
  ])("build-Stage prueft, dass %s im Standalone-Output liegt", (file) => {
    expect(buildStage).toContain(file);
    expect(buildStage).toMatch(/fehlt im Standalone-Output/);
  });

  it("runner-Stage uebernimmt den Standalone-Output samt statischer Dateien", () => {
    expect(runnerStage).toMatch(/COPY --from=build \/app\/\.next\/standalone \.\//);
    expect(runnerStage).toMatch(/COPY --from=build \/app\/\.next\/static \.\/\.next\/static/);
    expect(runnerStage).toMatch(/COPY --from=build \/app\/public \.\/public/);
  });

  it("laeuft als unprivilegierter Benutzer mit tini als PID 1, Programmdateien root-eigen", () => {
    expect(runnerStage).toMatch(/^USER node$/m);
    expect(runnerStage).toMatch(/^ENTRYPOINT \["\/usr\/bin\/tini", "--"\]$/m);
    expect(runnerStage).not.toMatch(/^COPY .*--chown/m);
    // Ohne explizites Mount sollen Belege nicht unbemerkt in anonymen Volumes landen.
    expect(runnerStage).not.toMatch(/^VOLUME/m);
  });

  it("runner-Stage enthaelt das Notfallskript disable-2fa.sh", () => {
    expect(runnerStage).toMatch(/\/app\/scripts\/disable-2fa\.sh/);
  });

  it("Pruefung eingehender E-Rechnungen: Validator und Java-Laufzeit kommen aus eigenen Stages, nichts wird zur Laufzeit geladen", () => {
    expect(dockerfile).toMatch(/^FROM base AS einvoice-validator$/m);
    expect(dockerfile).toMatch(/^FROM base AS jre$/m);
    expect(dockerfile).toMatch(/fetch-einvoice-validator\.sh \/opt\/validator/);
    expect(dockerfile).toMatch(/jlink --add-modules java\.base,/);
    expect(runnerStage).toMatch(/COPY --from=einvoice-validator \/opt\/validator \/opt\/validator/);
    expect(runnerStage).toMatch(/COPY --from=jre \/opt\/jre \/opt\/jre/);
    expect(runnerStage).toMatch(/EINVOICE_VALIDATOR_DIR=\/opt\/validator/);
    expect(runnerStage).toMatch(/EINVOICE_JAVA=\/opt\/jre\/bin\/java/);
    // Die Laufzeit-Stage bricht ab, wenn Java oder Validator fehlen.
    expect(runnerStage).toMatch(/\/opt\/jre\/bin\/java -version/);
  });

  it("Pruefartefakte: feste Pruefsummen, Lizenztexte liegen im Repository", () => {
    const pins = read("assets/einvoice-validation/pins.env");
    expect(pins).toMatch(/^VALIDATOR_SHA256=[0-9a-f]{64}$/m);
    expect(pins).toMatch(/^CONFIG_SHA256=[0-9a-f]{64}$/m);
    const script = read("scripts/fetch-einvoice-validator.sh");
    expect(script).toMatch(/Pruefsumme von .* weicht ab/);
    for (const f of ["LICENSE-validator-Apache-2.0.txt", "LICENSE-xrechnung-configuration-Apache-2.0.txt", "LICENSE-en16931-validation-EUPL-1.2.txt", "NOTICE-validator.txt"]) {
      expect(read(`assets/einvoice-validation/LICENSES/${f}`).length).toBeGreaterThan(1000);
    }
  });

  it("next.config.ts nimmt Worker-Skript und Pruefartefakte ins Tracing auf", () => {
    const cfg = read("next.config.ts");
    expect(cfg).toContain("outputFileTracingIncludes");
    expect(cfg).toContain("./src/workers/**/*");
    expect(cfg).toContain("./assets/einvoice-validation/**/*");
  });

  it("Basis-Image steht als literale FROM-Zeile mit Digest (Dependabot)", () => {
    expect(dockerfile).toMatch(/^FROM node:\d+\.\d+\.\d+-[a-z]+-slim@sha256:[0-9a-f]{64} AS base$/m);
  });

  it("Prisma-CLI im Image hat dieselben Versionen wie package-lock.json", () => {
    const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { version: string }> };
    const cli = JSON.parse(read("docker/prisma-cli/package.json")) as { dependencies: Record<string, string> };
    const cliLock = JSON.parse(read("docker/prisma-cli/package-lock.json")) as { packages: Record<string, { version: string }> };
    for (const name of ["prisma", "dotenv"]) {
      expect(cli.dependencies[name]).toBe(lock.packages[`node_modules/${name}`].version);
      expect(cliLock.packages[`node_modules/${name}`].version).toBe(lock.packages[`node_modules/${name}`].version);
    }
    // Sicherheits-Override (deepmerge-ts, Abhaengigkeit von @prisma/config) in beiden Lockfiles gleich.
    expect(cliLock.packages["node_modules/deepmerge-ts"].version).toBe(lock.packages["node_modules/deepmerge-ts"].version);
  });
});

describe(".dockerignore", () => {
  it("ist eine Whitelist (alles ausgeschlossen, Freigaben einzeln)", () => {
    expect(ignoreLines[0]).toBe("*");
  });

  it.each(["!openapi/openapi.json", "!assets/fonts/", "!src/", "!public/", "!prisma/migrations-postgres/", "!scripts/disable-2fa.sh", "!assets/einvoice-validation/", "!scripts/fetch-einvoice-validator.sh"])(
    "gibt %s frei",
    (entry) => {
      expect(ignoreLines).toContain(entry);
    },
  );

  it("laesst Screenshots, Social-Grafiken, Doku, Tests und Secrets nicht durch", () => {
    const allowed = ignoreLines.filter((l) => l.startsWith("!"));
    for (const entry of allowed) {
      expect(entry).not.toMatch(/^!(docs|test|scratchpad|data|\.env|\.superpowers)\b/);
      expect(entry).not.toBe("!assets/");
    }
  });
});
