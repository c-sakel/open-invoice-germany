/**
 * Zod-Schemas fuer die Anmeldung (Phase 14a, Task 8, R12) — eine Quelle fuer Route
 * (`src/app/api/auth/login/route.ts`) UND Domaene (`src/domain/auth/login.ts`), damit
 * beide dieselbe Fehlermeldung bei fehlender/leerer Eingabe liefern.
 */
import { z } from "zod";

export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

/**
 * Passwort aendern (Phase 14a, Task 9, R12) — eine Quelle fuer Route
 * (`src/app/api/auth/password/route.ts`) UND Domaene (`src/domain/auth/login.ts#changePassword`).
 * `currentPassword` ist Pflicht (kein Passwortwechsel ohne Kenntnis des alten Passworts),
 * `newPassword` mind. 10 Zeichen, `newPasswordRepeat` muss uebereinstimmen.
 */
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(10),
    newPasswordRepeat: z.string().min(1),
  })
  .refine((data) => data.newPassword === data.newPasswordRepeat, {
    message: "Die Wiederholung stimmt nicht mit dem neuen Passwort ueberein.",
    path: ["newPasswordRepeat"],
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/** Zweiter Faktor bei der Anmeldung: TOTP (6 Ziffern) oder Wiederherstellungscode (Phase 17d). */
export const secondFactorSchema = z.object({ code: z.string().trim().min(6).max(32) });
export type SecondFactorInput = z.infer<typeof secondFactorSchema>;

/** 2FA aktivieren: Bestaetigungscode aus der Authenticator-App. */
export const totpEnableSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/) });
export type TotpEnableInput = z.infer<typeof totpEnableSchema>;

/** 2FA abschalten und Wiederherstellungscodes erneuern: Passwort UND zweiter Faktor. */
export const totpConfirmSchema = z.object({ password: z.string().min(1), code: z.string().trim().min(6).max(32) });
export type TotpConfirmInput = z.infer<typeof totpConfirmSchema>;
