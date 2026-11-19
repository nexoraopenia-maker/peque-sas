import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

/**
 * Cifrado simétrico de credenciales de WhatsApp (AES-256-GCM).
 *  - La clave se DERIVA de AUTH_SECRET con HKDF (nunca se usa AUTH_SECRET directamente).
 *  - Los datos autenticados (AAD) incluyen tenantId y nombre del campo: un texto cifrado copiado a otro tenant o a otro campo
 *    NO se puede descifrar. Cualquier alteración del texto cifrado también falla.
 *  - Formato: v1.<iv>.<tag>.<ciphertext> en base64url (el prefijo permite rotar el algoritmo/clave en el futuro).
 * Si se rota AUTH_SECRET hay que volver a guardar las credenciales de cada tenant (documentado en docs/WHATSAPP_META_SETUP.md).
 */
function masterKey(): Buffer {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) throw new Error("AUTH_SECRET debe tener al menos 32 caracteres");
  return Buffer.from(hkdfSync("sha256", s, "pequessaas-whatsapp-salt", "pequessaas:whatsapp-credentials:v1", 32));
}

export const aad = (tenantId: string, field: string) => Buffer.from(`${tenantId}:${field}`);

export function encryptSecret(plain: string, tenantId: string, field: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", masterKey(), iv);
  c.setAAD(aad(tenantId, field));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(blob: string, tenantId: string, field: string): string {
  const [v, iv, tag, ct] = blob.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Formato de secreto no válido");
  const d = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(iv, "base64url"));
  d.setAAD(aad(tenantId, field));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

/** Huella para buscar un verify token sin guardarlo en claro en una columna indexada. */
export const hashVerifyToken = (token: string) => createHmac("sha256", masterKey()).update(`verify:${token}`).digest("hex");
export const generateVerifyToken = () => randomBytes(24).toString("base64url");
