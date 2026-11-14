/**
 * Enter in einem Eingabefeld darf ein Formular nicht absenden (Abo-Editor: Positionstabelle
 * sitzt im <form>). Ausnahmen: Textareas (Zeilenumbruch), Buttons/Links (Aktivierung),
 * Auswahlfelder und laufende IME-Eingabe. Reine Funktion, damit sie ohne DOM testbar ist.
 */
export function shouldBlockEnterSubmit(e: { key: string; isComposing?: boolean; target: { tagName?: string; type?: string } }): boolean {
  if (e.key !== "Enter" || e.isComposing) return false;
  const tag = (e.target.tagName ?? "").toUpperCase();
  if (tag !== "INPUT") return false;
  const type = (e.target.type ?? "").toLowerCase();
  return type !== "submit" && type !== "button" && type !== "reset";
}
