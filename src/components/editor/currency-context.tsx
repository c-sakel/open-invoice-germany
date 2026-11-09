"use client";

/**
 * Anzeigewaehrung des Editors (Kunde > Einstellung > EUR). Reine Anzeige: gesendet wird nur
 * `DraftState.currency` (leer = Server-Kette). Die Bloecke lesen sie per Hook, damit nicht
 * jede Zeile eine Prop durchgereicht bekommt.
 */
import { createContext, useContext } from "react";
import { currencySymbol } from "@/lib/currencies";

export const EditorCurrencyContext = createContext<string>("EUR");

/** Anzeigecode (z. B. "CHF"). */
export function useEditorCurrency(): string {
  return useContext(EditorCurrencyContext);
}

/** Anzeigesymbol ("€" fuer EUR, sonst der Code). */
export function useEditorCurrencySymbol(): string {
  return currencySymbol(useContext(EditorCurrencyContext));
}
