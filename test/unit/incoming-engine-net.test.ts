/**
 * Netzwirkung des Pruefers: Rechnungen mit externer Entitaet, schemaLocation und XInclude auf einen lokalen
 * Listener duerfen keine Anfrage ausloesen. Direkt an der Engine (die XML-Sicherheitspruefung der Annahme wird
 * hier bewusst umgangen). Nur mit echtem Validator und Java ab 17.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { realValidatorEngine } from "../helpers/real-validator";

const engine = realValidatorEngine();
let server: Server;
let requests: string[] = [];
let port = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req.url ?? "");
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe.skipIf(engine === null)("Pruefer ohne Netzwirkung", () => {
  const run = async (xml: string) => {
    if (!engine) throw new Error("kein Validator");
    requests = [];
    const out = await engine.run(xml, { timeoutMs: 60_000 });
    // Etwaige verzoegerte Verbindungen abwarten.
    await new Promise((r) => setTimeout(r, 300));
    return out;
  };

  it("externe Entitaet (DOCTYPE) ruft nichts ab", async () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE Invoice [<!ENTITY x SYSTEM "http://127.0.0.1:${port}/entity">]><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">&x;</Invoice>`;
    await run(xml);
    expect(requests).toEqual([]);
  });

  it("xsi:schemaLocation ruft nichts ab", async () => {
    const xml = `<?xml version="1.0"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2 http://127.0.0.1:${port}/schema.xsd"/>`;
    await run(xml);
    expect(requests).toEqual([]);
  });

  it("XInclude ruft nichts ab", async () => {
    const xml = `<?xml version="1.0"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include href="http://127.0.0.1:${port}/include.xml"/></Invoice>`;
    await run(xml);
    expect(requests).toEqual([]);
  });
});
