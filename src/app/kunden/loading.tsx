import { LoadingSkeleton } from "@/components/ui/LoadingSkeleton";

export default function KundenLoading() {
  // Kopf, Suchzeile und eine Seite Tabellenzeilen (Seitengroesse 50, hier gekuerzt).
  return <LoadingSkeleton rows={10} />;
}
