export default function EditorLoading() {
  return (
    <div aria-busy="true" role="status" className="space-y-4">
      <span className="sr-only">Lädt…</span>
      <div aria-hidden="true" className="h-8 w-56 animate-pulse rounded bg-rule" />
      <div aria-hidden="true" className="grid gap-4 sm:grid-cols-2">
        <div className="h-24 animate-pulse rounded bg-rule/60" />
        <div className="h-24 animate-pulse rounded bg-rule/60" />
      </div>
      <div aria-hidden="true" className="h-64 animate-pulse rounded bg-rule/60" />
    </div>
  );
}
