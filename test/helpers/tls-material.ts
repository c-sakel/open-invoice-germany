/**
 * Selbstsigniertes Zertifikat fuer lokale Testserver (nur 127.0.0.1). Entsteht zur Laufzeit per openssl in einem
 * Temp-Verzeichnis und liegt danach nur im Speicher; es gibt keine Zertifikatsdatei im Repository.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TlsMaterial {
  cert: string;
  key: string;
}

/** Ist openssl vorhanden? */
export function opensslAvailable(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Selbstsigniertes Zertifikat fuer einen DNS-Namen; Dateien nur kurz im Temp-Verzeichnis, ohne .pem-Namen. */
export function createTestTlsMaterial(dnsName: string): TlsMaterial {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tls-test-"));
  try {
    const certFile = path.join(dir, "server-cert.txt");
    const keyFile = path.join(dir, "server-k8.txt");
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes",
        "-keyout", keyFile, "-out", certFile, "-days", "2", "-subj", `/CN=${dnsName}`,
        "-addext", `subjectAltName=DNS:${dnsName}`,
      ],
      { stdio: "ignore" },
    );
    return { cert: fs.readFileSync(certFile, "utf8"), key: fs.readFileSync(keyFile, "utf8") };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
