import { createHmac, timingSafeEqual } from "node:crypto";

// Lógica pura de suscripciones y firmas de pasarela (sin BD ni red) para poder probarla.
export const GRACE_DAYS = 5;          // días de gracia tras vencer el periodo antes de bloquear el acceso
export const RENEWAL_LEAD_DAYS = 7;   // el cobro del siguiente periodo se genera con esta anticipación
export const TRIAL_DAYS = 7;          // primer periodo (sin cobro) al pasar a un plan de pago
const DAY = 86_400_000;
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
export const periodDays = (start: Date, end: Date) => Math.max(1, Math.round((end.getTime() - start.getTime()) / DAY));

export type SubView = { status: "ACTIVE" | "PAST_DUE" | "CANCELED"; currentPeriodEnd: Date; graceUntil: Date | null };
export type CycleAction = "CREATE_INVOICE" | "MARK_PAST_DUE" | "SUSPEND";

/**
 * Decisiones del ciclo de cobro (el cron las ejecuta de forma idempotente):
 *  - CREATE_INVOICE: faltan ≤ 7 días (o ya venció) y no hay cobro pendiente del siguiente periodo.
 *  - MARK_PAST_DUE: pasó el fin del periodo sin pago.
 *  - SUSPEND: pasó la gracia (fin del periodo + GRACE_DAYS) sin pago.
 */
export function decideCycle(sub: SubView, hasPendingInvoice: boolean, now: Date): CycleAction[] {
  if (sub.status === "CANCELED") return [];
  const out: CycleAction[] = [];
  const end = sub.currentPeriodEnd;
  if (!hasPendingInvoice && now.getTime() >= end.getTime() - RENEWAL_LEAD_DAYS * DAY) out.push("CREATE_INVOICE");
  if (now.getTime() > end.getTime()) {
    if (sub.status === "ACTIVE") out.push("MARK_PAST_DUE");
    const grace = sub.graceUntil ?? addDays(end, GRACE_DAYS);
    if (now.getTime() > grace.getTime()) out.push("SUSPEND");
  }
  return out;
}

export type DueInfo = { state: "OK" | "DUE_SOON" | "PAST_DUE" | "CANCELED"; daysLeft: number };
/** Estado para mostrar al propietario. daysLeft: días hasta el fin del periodo (negativo si ya venció). */
export function dueInfo(sub: SubView | null, now: Date): DueInfo | null {
  if (!sub) return null;
  if (sub.status === "CANCELED") return { state: "CANCELED", daysLeft: 0 };
  const daysLeft = Math.ceil((sub.currentPeriodEnd.getTime() - now.getTime()) / DAY);
  if (now.getTime() > sub.currentPeriodEnd.getTime()) return { state: "PAST_DUE", daysLeft };
  return { state: daysLeft <= RENEWAL_LEAD_DAYS ? "DUE_SOON" : "OK", daysLeft };
}

/** Nuevo fin de periodo al pagar: si aún estaba vigente se suma al fin actual; si ya había vencido, cuenta desde hoy. */
export function paidPeriodEnd(currentEnd: Date, days: number, now: Date): Date {
  return addDays(currentEnd.getTime() > now.getTime() ? currentEnd : now, days);
}

const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** Firma de avisos de Mercado Pago: cabecera x-signature "ts=…,v1=…" = HMAC-SHA256 hex de `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`. */
export function verifyMercadoPagoSignature(p: { secret: string; xSignature: string | null; xRequestId: string | null; dataId: string | null }): boolean {
  if (!p.secret || !p.xSignature || !p.dataId) return false;
  const parts = Object.fromEntries(p.xSignature.split(",").map((kv) => kv.trim().split("=", 2) as [string, string]));
  if (!parts.ts || !parts.v1) return false;
  const manifest = `id:${p.dataId.toLowerCase()};${p.xRequestId ? `request-id:${p.xRequestId};` : ""}ts:${parts.ts};`;
  return safeEq(createHmac("sha256", p.secret).update(manifest).digest("hex"), parts.v1);
}
export const signMercadoPago = (secret: string, dataId: string, xRequestId: string, ts: string) =>
  `ts=${ts},v1=${createHmac("sha256", secret).update(`id:${dataId.toLowerCase()};request-id:${xRequestId};ts:${ts};`).digest("hex")}`;

/** Firma del sandbox (adaptador simulado): HMAC-SHA256 hex del cuerpo CRUDO con una clave derivada de AUTH_SECRET. */
export const mockSignature = (raw: string | Buffer, key: string) => createHmac("sha256", key).update(raw).digest("hex");
export const verifyMockSignature = (raw: Buffer, header: string | null, key: string) => !!header && safeEq(mockSignature(raw, key), header);
