import type { ReactNode } from "react";
import { PageContainer } from "@/components/PageContainer";

/**
 * Ein Layout statt 16 Seitenaenderungen (Phase 13a, Task 1): schnuert alle
 * Einstellungsseiten auf eine lesbare Formularbreite ein — `AppShell` gibt seit
 * dieser Phase 1600px frei, was fuer ein Einstellungsformular unlesbar waere.
 */
export default function EinstellungenLayout({ children }: { children: ReactNode }) {
  return <PageContainer width="form">{children}</PageContainer>;
}
