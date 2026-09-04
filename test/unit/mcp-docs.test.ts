/**
 * Doku-Drift-Test (Task 3, Phase 9): jede per `registerTool("…")` registrierte MCP-Tool-ID muss
 * in docs/MCP.md als Backtick-ID vorkommen, und umgekehrt darf docs/MCP.md keine Backtick-ID
 * nennen, die nicht registriert ist — mit Ausnahme des Abschnitts "## Entfernt" (dort duerfen
 * alte, entfernte Toolnamen als Backtick-ID stehen, z. B. `save_document_settings`).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const MCP_TOOLS_DIR = path.join(process.cwd(), "src/mcp/tools");
const MCP_DOCS_PATH = path.join(process.cwd(), "docs/MCP.md");

function collectRegisteredToolIds(): Set<string> {
  const ids = new Set<string>();
  const files = readdirSync(MCP_TOOLS_DIR).filter((f) => f.endsWith(".ts"));
  const re = /registerTool\(\s*"([a-z_]+)"/g;
  for (const file of files) {
    const source = readFileSync(path.join(MCP_TOOLS_DIR, file), "utf8");
    for (const match of source.matchAll(re)) {
      ids.add(match[1]);
    }
  }
  return ids;
}

/** Schneidet den Abschnitt "## Entfernt" (falls vorhanden) aus dem Markdown heraus, bis zur
 * naechsten "## "-Überschrift oder Dateiende — Backtick-IDs darin gelten nicht als Drift. */
function stripRemovedSection(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let inRemoved = false;
  for (const line of lines) {
    if (/^##\s+Entfernt\b/.test(line)) {
      inRemoved = true;
      continue;
    }
    if (inRemoved && /^##\s+/.test(line)) {
      inRemoved = false;
    }
    if (!inRemoved) out.push(line);
  }
  return out.join("\n");
}

function collectDocBacktickIds(markdown: string): Set<string> {
  const ids = new Set<string>();
  const re = /`([a-z_]+)`/g;
  for (const match of markdown.matchAll(re)) {
    ids.add(match[1]);
  }
  return ids;
}

describe("docs/MCP.md — Doku-Drift", () => {
  const registeredIds = collectRegisteredToolIds();
  const rawDocs = readFileSync(MCP_DOCS_PATH, "utf8");
  const docsWithoutRemoved = stripRemovedSection(rawDocs);
  const docIdsExcludingRemoved = collectDocBacktickIds(docsWithoutRemoved);

  it("registriert mindestens ein Tool (Regex/Verzeichnis funktionieren)", () => {
    expect(registeredIds.size).toBeGreaterThan(0);
  });

  it("jede registrierte Tool-ID kommt in docs/MCP.md als Backtick-ID vor", () => {
    const missing = [...registeredIds].filter((id) => !docIdsExcludingRemoved.has(id)).sort();
    expect(missing, `In docs/MCP.md fehlende Tool-IDs: ${missing.join(", ")}`).toEqual([]);
  });

  it("docs/MCP.md nennt keine Backtick-ID, die aussieht wie ein Tool-Name, aber nicht registriert ist (ausserhalb '## Entfernt')", () => {
    const toolLikePattern = /^[a-z]+(_[a-z]+)+$/;
    const stray = [...docIdsExcludingRemoved]
      .filter((id) => toolLikePattern.test(id) && !registeredIds.has(id))
      .sort();
    expect(stray, `In docs/MCP.md genannte, nicht registrierte Tool-IDs: ${stray.join(", ")}`).toEqual([]);
  });
});
