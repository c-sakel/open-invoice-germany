/**
 * docker-entrypoint.sh leitet den Schluessel fuer Next.js-Server-Actions je Installation aus
 * AUTH_SECRET ab. Ohne diesen Schritt gilt der beim Bauen erzeugte Schluessel, den ein
 * oeffentliches Image mit allen Installationen teilt. Der Test fuehrt genau den Block aus
 * dem Entrypoint in einer POSIX-Shell aus.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const entrypoint = readFileSync(path.join(process.cwd(), "scripts/docker-entrypoint.sh"), "utf8");
const block = entrypoint.slice(entrypoint.indexOf("# BEGIN server-actions-key"), entrypoint.indexOf("# END server-actions-key"));

function run(env: Record<string, string>): string {
  const childEnv: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH ?? "", ...env };
  return execFileSync("sh", ["-c", `${block}\nprintf '%s' "\${NEXT_SERVER_ACTIONS_ENCRYPTION_KEY:-}"`], {
    env: childEnv,
    encoding: "utf8",
  });
}

describe("docker-entrypoint.sh: Server-Actions-Schluessel", () => {
  it("Block ist im Entrypoint vorhanden und steht vor dem Serverstart", () => {
    expect(block).toContain("NEXT_SERVER_ACTIONS_ENCRYPTION_KEY");
    expect(entrypoint.indexOf("# END server-actions-key")).toBeLessThan(entrypoint.indexOf("exec node server.js"));
  });

  it("leitet aus AUTH_SECRET einen 256-Bit-Schluessel ab, stabil und je Secret verschieden", () => {
    const a = run({ AUTH_SECRET: "installation-a-0123456789abcdef" });
    const a2 = run({ AUTH_SECRET: "installation-a-0123456789abcdef" });
    const b = run({ AUTH_SECRET: "installation-b-0123456789abcdef" });
    expect(Buffer.from(a, "base64")).toHaveLength(32);
    expect(a).toBe(a2);
    expect(a).not.toBe(b);
  });

  it("ein ausdruecklich gesetzter Schluessel hat Vorrang", () => {
    expect(run({ AUTH_SECRET: "x-0123456789abcdef", NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: "vorgegeben" })).toBe("vorgegeben");
  });

  it("ohne AUTH_SECRET bleibt der Schluessel ungesetzt (Next.js nimmt dann den Build-Schluessel)", () => {
    expect(run({})).toBe("");
  });
});
