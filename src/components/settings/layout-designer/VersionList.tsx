"use client";

import { Button } from "@/components/ui/Button";

export interface VersionInfo {
  id: string;
  version: number;
  createdAt: string;
}

const formatDate = (iso: string) => new Date(iso).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" });

export function VersionList({
  versions,
  currentVersion,
  previewVersion,
  onPreview,
}: {
  versions: VersionInfo[];
  currentVersion: number;
  previewVersion: number | null;
  onPreview: (version: number | null) => void;
}) {
  if (versions.length === 0) return <p className="text-sm text-ink-muted">Noch keine gespeicherte Version.</p>;
  return (
    <ul className="space-y-1.5">
      {[...versions].reverse().map((v) => (
        <li key={v.id} className="flex items-center gap-2 rounded-[var(--radius-control)] bg-well px-2 py-1.5 text-sm">
          <span className="font-medium text-ink">Version {v.version}</span>
          {v.version === currentVersion && <span className="rounded-full bg-pen px-2 py-0.5 text-[10px] font-medium text-on-accent">aktuell</span>}
          <span className="flex-1 text-xs text-ink-muted">{formatDate(v.createdAt)}</span>
          {previewVersion === v.version ? (
            <Button variant="quiet" size="sm" onClick={() => onPreview(null)}>
              Zurück zum Entwurf
            </Button>
          ) : (
            <Button variant="secondary" size="sm" aria-label={`Vorschau Version ${v.version}`} onClick={() => onPreview(v.version)}>
              Vorschau
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
