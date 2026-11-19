/**
 * Número a "wa_id" (solo dígitos, con código de país). Perú: 9 dígitos → 51 + número.
 * Devuelve null si no parece un número válido (8–15 dígitos en formato internacional).
 */
export function toWaId(input: string | null | undefined, countryCode = "51"): string | null {
  const d = (input ?? "").replace(/\D/g, "");
  if (d.length === 9) return `${countryCode}${d}`;
  if (d.length >= 10 && d.length <= 15 && !d.startsWith("0")) return d;
  return null;
}

/** Ventana de atención al cliente de 24 h desde el último mensaje ENTRANTE del usuario. */
export const WINDOW_MS = 24 * 3600_000;
export const inServiceWindow = (lastInboundAt: Date | null | undefined, now = new Date()) =>
  !!lastInboundAt && now.getTime() - lastInboundAt.getTime() < WINDOW_MS;
