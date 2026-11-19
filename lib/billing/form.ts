import { METHODS, parseSoles, type Method } from "./money";
import type { Payment } from "./service";

/** Lee los campos de pago comunes: method, amount (opcional, S/), method2 (para el resto). */
export function parsePayment(form: FormData): Payment | { error: string } {
  const first = String(form.get("method") ?? "") as Method;
  if (!METHODS.includes(first)) return { error: "Selecciona el método de pago" };
  const raw = String(form.get("amount") ?? "").trim();
  let firstAmountCents: number | null = null;
  if (raw) {
    firstAmountCents = parseSoles(raw);
    if (firstAmountCents === null) return { error: "Monto inválido (máx. 2 decimales)" };
  }
  const s = String(form.get("method2") ?? "") as Method;
  return { first, firstAmountCents, second: METHODS.includes(s) ? s : null };
}

/** Campos opcionales de promoción: cupón, puntos a canjear y apoderado (DNI/teléfono). El servidor los valida y recalcula. */
export function promoFromForm(form: FormData): import("./promos").PromoInput | undefined {
  const couponCode = String(form.get("coupon") ?? "").trim();
  const guardianLookup = String(form.get("guardian") ?? "").trim();
  const redeem = Math.floor(Number(String(form.get("redeem") ?? "").trim() || 0));
  if (!couponCode && !guardianLookup && !(redeem > 0)) return undefined;
  return {
    ...(couponCode ? { couponCode } : {}),
    ...(guardianLookup ? { guardianLookup } : {}),
    ...(redeem > 0 ? { redeemPoints: redeem } : {}),
  };
}
