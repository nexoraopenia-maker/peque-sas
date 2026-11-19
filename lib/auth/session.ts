import "server-only";
import { cookies } from "next/headers";
import { COOKIE, signToken, verifyToken, type SessionPayload } from "./token";

export type { SessionPayload };
const MAX_AGE = 60 * 60 * 8; // 8 horas
/** El contexto de SuperAdmin es más corto: 2 horas. */
export const SUPERADMIN_MAX_AGE = 60 * 60 * 2;

/** Crea la sesión. El indicador `sa` solo lo recibe un usuario con rol SUPERADMIN (lo decide el servidor, nunca el navegador). */
export async function createSession(payload: SessionPayload) {
  const maxAge = payload.sa ? SUPERADMIN_MAX_AGE : MAX_AGE;
  (await cookies()).set(COOKIE, await signToken(payload, maxAge), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge,
  });
}

export async function readSession(): Promise<SessionPayload | null> {
  return verifyToken((await cookies()).get(COOKIE)?.value);
}

export async function destroySession() {
  (await cookies()).delete(COOKIE);
}
