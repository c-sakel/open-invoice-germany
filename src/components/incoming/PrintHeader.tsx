import { formatReceivedAt } from "./incoming-ui";

/** Kopfzeile der Druckansicht: Hinweis auf die maßgebliche Originaldatei, Eingangszeitpunkt und Prüfsumme. */
export function PrintHeader({ receivedAt, sha256, fileName }: { receivedAt: string | null; sha256: string; fileName: string }) {
  return (
    <header className="space-y-1 border-b border-rule pb-3 text-sm">
      <p className="font-medium text-ink">Lesefassung — maßgeblich ist die Originaldatei</p>
      <p className="break-all text-ink-soft">Datei: {fileName}</p>
      <p className="text-ink-soft">Eingang: {formatReceivedAt(receivedAt)}</p>
      <p className="break-all text-ink-soft">
        SHA-256: <span className="font-mono text-xs">{sha256}</span>
      </p>
    </header>
  );
}
