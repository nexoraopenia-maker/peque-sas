import "server-only";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";

// Sesión del apoderado: cookie y token DISTINTOS de los del personal (typ "parent", sin `uid`).
// Un token de personal no sirve aquí y uno de apoderado no sirve en el panel.
export const PARENT_COOKIE = "pq_parent";
const MAX_AGE = 60 * 60 * 12;

export type GuardianToken = { gid: string; tid: string; sv: number };

const key = () => {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) throw new Error("AUTH_SECRET debe tener al menos 32 caracteres");
  return new TextEncoder().encode(s);
};

export const signGuardianToken = (p: GuardianToken) =>
  new SignJWT({ ...p, typ: "parent" }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime(`${MAX_AGE}s`).sign(key());

export async function verifyGuardianToken(token: string): Promise<GuardianToken | null> {
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    if (payload.typ !== "parent" || typeof payload.gid !== "string" || typeof payload.tid !== "string" || typeof payload.sv !== "number") return null;
    return { gid: payload.gid, tid: payload.tid, sv: payload.sv };
  } catch {
    return null;
  }
}

export async function setGuardianSession(p: GuardianToken) {
  (await cookies()).set(PARENT_COOKIE, await signGuardianToken(p), {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/parent-portal", maxAge: MAX_AGE,
  });
}
export const readGuardianToken = async () => (await cookies()).get(PARENT_COOKIE)?.value;
export const clearGuardianSession = async () => (await cookies()).delete({ name: PARENT_COOKIE, path: "/parent-portal" });
