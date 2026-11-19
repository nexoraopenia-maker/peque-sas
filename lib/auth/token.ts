import { SignJWT, jwtVerify } from "jose";

/** Firma/verificación del JWT de sesión. Sin `server-only` para poder usarse también desde proxy.ts. */
export const COOKIE = "pq_session";
export type SessionPayload = { uid: string; sv: number; /** true solo si el usuario es SUPERADMIN (contexto administrativo separado) */ sa?: boolean };

function key() {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("AUTH_SECRET debe tener al menos 32 caracteres");
  return new TextEncoder().encode(secret);
}

export async function signToken(payload: SessionPayload, maxAgeSeconds: number) {
  return new SignJWT({ ...payload }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime(`${maxAgeSeconds}s`).sign(key());
}

export async function verifyToken(token: string | undefined): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    if (typeof payload.uid !== "string" || typeof payload.sv !== "number") return null;
    return { uid: payload.uid, sv: payload.sv, sa: payload.sa === true };
  } catch {
    return null;
  }
}
