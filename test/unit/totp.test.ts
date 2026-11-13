import { describe, it, expect } from "vitest";
import {
  base32Encode,
  base32Decode,
  hotp,
  totpStep,
  matchTotp,
  generateTotpSecret,
  otpauthUri,
} from "@/lib/auth/totp";
import { randomBytes } from "node:crypto";

const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");

describe("hotp (RFC 4226 Anhang D)", () => {
  const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  it.each(expected.map((c, i) => [i, c] as const))("Zaehler %i -> %s", (counter, code) => {
    expect(hotp(RFC_SECRET, counter)).toBe(code);
  });
});

describe("TOTP (RFC 6238 Anhang B, SHA-1, 8 Ziffern)", () => {
  const vectors: Array<[number, string]> = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  it.each(vectors)("T=%i -> %s", (t, code) => {
    expect(hotp(RFC_SECRET, totpStep(new Date(t * 1000)), 8)).toBe(code);
  });
});

describe("base32 (RFC 4648)", () => {
  it("Testvektoren", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Encode(Buffer.from("f"))).toBe("MY");
    expect(base32Encode(Buffer.from("fo"))).toBe("MZXQ");
    expect(base32Encode(Buffer.from(""))).toBe("");
  });
  it("Rundreise 0-64 Zufallsbytes", () => {
    for (let n = 0; n <= 64; n++) {
      const b = randomBytes(n);
      expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
    }
  });
  it("ignoriert Leerzeichen, Padding und Kleinschreibung", () => {
    expect(base32Decode("mzxw 6ytb oi==").toString()).toBe("foobar");
  });
  it("fremdes Zeichen wirft", () => {
    expect(() => base32Decode("MZ1")).toThrow();
  });
});

describe("matchTotp", () => {
  const now = new Date(1_700_000_000_000);
  const s = totpStep(now);
  const codeAt = (step: number) => hotp(RFC_SECRET, step);

  it("trifft Schritte s-1, s, s+1", () => {
    expect(matchTotp(RFC_SECRET, codeAt(s - 1), now)).toBe(s - 1);
    expect(matchTotp(RFC_SECRET, codeAt(s), now)).toBe(s);
    expect(matchTotp(RFC_SECRET, codeAt(s + 1), now)).toBe(s + 1);
  });
  it("s-2 und s+2 -> null", () => {
    expect(matchTotp(RFC_SECRET, codeAt(s - 2), now)).toBeNull();
    expect(matchTotp(RFC_SECRET, codeAt(s + 2), now)).toBeNull();
  });
  it("Replay-Schutz: nur Schritte > lastStep", () => {
    expect(matchTotp(RFC_SECRET, codeAt(s), now, { lastStep: s })).toBeNull();
    expect(matchTotp(RFC_SECRET, codeAt(s - 1), now, { lastStep: s })).toBeNull();
    expect(matchTotp(RFC_SECRET, codeAt(s + 1), now, { lastStep: s })).toBe(s + 1);
  });
  it("Format: nur genau sechs Ziffern", () => {
    expect(matchTotp(RFC_SECRET, "12345", now)).toBeNull();
    expect(matchTotp(RFC_SECRET, "1234567", now)).toBeNull();
    expect(matchTotp(RFC_SECRET, "12a456", now)).toBeNull();
  });
  it("fuehrende Nullen bleiben erhalten", () => {
    // RFC-Vektor 07081804 (8 Ziffern) beginnt mit 0; hotp liefert immer volle Laenge.
    expect(hotp(RFC_SECRET, totpStep(new Date(1111111109 * 1000)), 8)).toMatch(/^0\d{7}$/);
    for (let step = 0; step < 200; step++) expect(hotp(RFC_SECRET, step)).toMatch(/^\d{6}$/);
  });
});

describe("Geheimnis und URI", () => {
  it("generateTotpSecret: 20 Byte, zufaellig", () => {
    const a = generateTotpSecret();
    expect(a.length).toBe(20);
    expect(a.equals(generateTotpSecret())).toBe(false);
  });
  it("otpauthUri", () => {
    const uri = otpauthUri({ secret: RFC_SECRET, account: "a@b.de", issuer: "Rechnung: Test & Co" });
    expect(uri).toBe(
      `otpauth://totp/Rechnung%3A%20Test%20%26%20Co:a%40b.de?secret=${base32Encode(RFC_SECRET)}&issuer=Rechnung%3A%20Test%20%26%20Co&algorithm=SHA1&digits=6&period=30`,
    );
  });
});
