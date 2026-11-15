/**
 * Vertrauenswuerdige Bezahladressen: nur https, exakter Hostname aus der Allowlist des Anbieters,
 * kein Benutzerinfo-Teil, kein abweichender Port.
 */
export function isTrustedCheckoutUrl(url: string, hosts: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === "https:" && u.username === "" && u.password === "" && u.port === "" && hosts.includes(u.hostname);
}
