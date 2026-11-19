import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Validación de X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(App Secret, cuerpo).
 * Meta documenta el cálculo sobre el payload; en Messenger precisa que usa la versión con Unicode escapado (\uXXXX, hex en minúscula).
 * Por eso se acepta el HMAC del cuerpo crudo o el de su variante con Unicode escapado (ambos siguen siendo HMAC con el secreto).
 * Comparación en tiempo constante. Nunca se debe parsear ni usar el cuerpo antes de validar.
 */
export const escapeUnicode = (s: string) => s.replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

const hmacHex = (secret: string, body: string | Buffer) => createHmac("sha256", secret).update(body).digest();

export function verifySignature(rawBody: Buffer, header: string | null, secrets: string[]): { ok: true; secret: string } | { ok: false } {
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header ?? "");
  if (!m || !secrets.length) return { ok: false };
  const given = Buffer.from(m[1]!, "hex");
  const text = rawBody.toString("utf8");
  const variants = [rawBody, ...(/[^\x00-\x7f]/.test(text) ? [Buffer.from(escapeUnicode(text), "utf8")] : [])];
  for (const secret of secrets) {
    if (!secret) continue;
    for (const v of variants) {
      const expected = hmacHex(secret, v);
      if (expected.length === given.length && timingSafeEqual(expected, given)) return { ok: true, secret };
    }
  }
  return { ok: false };
}

/** Para pruebas y utilidades: firma de un cuerpo con un secreto. */
export const signBody = (secret: string, body: string | Buffer) => `sha256=${hmacHex(secret, body).toString("hex")}`;
