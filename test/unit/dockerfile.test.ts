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
  });
});

describe(".dockerignore", () => {
  it("ist eine Whitelist (alles ausgeschlossen, Freigaben einzeln)", () => {
    expect(ignoreLines[0]).toBe("*");
  });

  it.each(["!openapi/openapi.json", "!assets/fonts/", "!src/", "!public/", "!prisma/migrations-postgres/"])(
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
