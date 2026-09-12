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
