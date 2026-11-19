import { createHmac, createHash, randomInt, timingSafeEqual } from "node:crypto";

export type Identifier = { kind: "dni" | "phone"; value: string };

/** DNI = 8 dígitos; teléfono = 9 dígitos (se admite el prefijo 51). Cualquier otra cosa es inválida. */
export function normalizeIdentifier(input: string): Identifier | null {
  const d = input.replace(/\D/g, "");
  if (d.length === 8) return { kind: "dni", value: d };
  if (d.length === 9) return { kind: "phone", value: d };
  if (d.length === 11 && d.startsWith("51")) return { kind: "phone", value: d.slice(2) };
  return null;
}

/** Datos de identidad que se guardan del apoderado (para poder buscarlo por DNI o por teléfono). */
export function guardianIdentity(i: { dni?: string | null; phone?: string | null }) {
  const dniDigits = (i.dni ?? "").replace(/\D/g, "");
  const phoneAll = (i.phone ?? "").replace(/\D/g, "");
  return {
    dni: dniDigits.length === 8 ? dniDigits : i.dni ?? null,
    phoneDigits: phoneAll.length >= 9 ? phoneAll.slice(-9) : null,
  };
}

export const CODE_TTL_MS = 15 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;
export const FAIL_WINDOW_MS = 15 * 60_000;
export const MAX_FAILS_PER_IDENTIFIER = 5;
export const MAX_FAILS_PER_PORTAL = 40;

/** Código de 8 dígitos, criptográficamente aleatorio. */
export const generateAccessCode = () => String(randomInt(0, 100_000_000)).padStart(8, "0");
export const formatAccessCode = (c: string) => `${c.slice(0, 4)} ${c.slice(4)}`;
export const normalizeCode = (c: string) => c.replace(/\D/g, "");

const secret = () => {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) throw new Error("AUTH_SECRET debe tener al menos 32 caracteres");
  return s;
};

/** El código nunca se guarda en claro: HMAC con el id del código como sal. */
export const hashAccessCode = (codeId: string, code: string) => createHmac("sha256", secret()).update(`${codeId}:${code}`).digest("hex");

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex"), y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Claves de limitación de intentos: hasheadas para no guardar DNI/teléfonos en claro. */
export const rateKeys = (portalCode: string, identifier: string) => {
  const h = (v: string) => createHash("sha256").update(`${secret()}|${v}`).digest("hex");
  return { perIdentifier: `ci:${h(`${portalCode.toUpperCase()}|${identifier}`)}`, perPortal: `c:${h(portalCode.toUpperCase())}` };
};

const PORTAL_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const generatePortalCode = (len = 8) => Array.from({ length: len }, () => PORTAL_ALPHABET[randomInt(PORTAL_ALPHABET.length)]).join("");
export const normalizePortalCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Claves de limitación para SOLICITUDES de código por WhatsApp (distintas de las de intentos de ingreso). */
export const requestKeys = (portalCode: string, identifier: string) => {
  const k = rateKeys(portalCode, identifier);
  return { perIdentifier: `rq:${k.perIdentifier}`, perPortal: `rqp:${k.perPortal}` };
};
export const MAX_REQUESTS_PER_IDENTIFIER = 3;
export const MAX_REQUESTS_PER_PORTAL = 30;
export const REQUEST_COOLDOWN_MS = 60_000;
