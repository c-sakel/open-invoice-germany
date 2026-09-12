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
