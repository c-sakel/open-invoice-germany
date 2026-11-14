# Sicherheitshinweise

## Schwachstellen melden

Bitte melde Sicherheitslücken **nicht** über öffentliche Issues, sondern vertraulich über GitHub: Reiter *Security* → **Report a vulnerability** (Private Vulnerability Reporting).

Wir bestätigen den Eingang i. d. R. innerhalb weniger Tage und halten dich über den Fortschritt auf dem Laufenden. Bitte gib uns angemessene Zeit zur Behebung, bevor du Details veröffentlichst (Responsible Disclosure).

## Hinweise zum sicheren Betrieb

- **Aufbewahrung & DSGVO**: Rechnungsdaten unterliegen gesetzlichen Aufbewahrungsfristen (siehe [COMPLIANCE.md](COMPLIANCE.md)). Lösch-/Sperrkonzept beachten.
- **Backups**: SQLite-Datei (`prisma/dev.db`) bzw. die PostgreSQL-Datenbank regelmäßig sichern. Die GoBD-Audit-Chain schützt vor *unbemerkter* Manipulation, ersetzt aber keine Backups.
- **Secrets**: Niemals echte Zugangsdaten committen. Alles über `.env` (ist in `.gitignore`).
- **Anmeldung**: Die App hat eine eingebaute Anmeldung (ein Admin-Konto, scrypt-Passwort-Hash, signiertes httpOnly-Session-Cookie; App + API sind geschützt). In **Produktion**: ein starkes `AUTH_SECRET` setzen (`openssl rand -base64 32`) und hinter **HTTPS** betreiben. Der Demo-Seed legt `admin@example.com` / `demo1234` an — diese Zugangsdaten in Produktion **sofort ändern** (bzw. eigenes Konto über `/setup` anlegen). Optional schützt eine **Zwei-Faktor-Anmeldung** (TOTP, Authenticator-App, mit einmaligen Wiederherstellungscodes) das Konto; ein **Passwort-Reset per E-Mail** (Link 30 Minuten gültig, einmal einlösbar) setzt ein eingerichtetes SMTP und `APP_BASE_URL` voraus. Bei verlorenem zweiten Faktor gibt es als **Notfallzugang** nur das Server-Skript `scripts/disable-2fa.sh`. Restrisiken: die IP-Bremsen im Speicher sind hinter einem falsch konfigurierten Proxy umgehbar (siehe `CLIENT_IP_SOURCE`), die Kontosperre (5 Fehlversuche, 15 Minuten) begrenzt das Raten von Codes, bleibt aber ein Restrisiko. Mehrbenutzer und Rollen sind bewusst nicht Teil des Projekts.
