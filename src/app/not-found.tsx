import Link from "next/link";

export default function NotFound() {
  return (
    <div className="space-y-3 py-10">
      <h1 className="text-lg font-semibold text-ink">Seite nicht gefunden</h1>
      <Link href="/" className="text-sm text-pen underline-offset-2 hover:underline">
        Zur Übersicht
      </Link>
    </div>
  );
}
