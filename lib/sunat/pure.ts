// Lógica pura de comprobantes electrónicos (sin BD ni red) para poder probarla.
export type DocKind = "BOLETA" | "FACTURA" | "CREDIT_NOTE";
export type CustomerDocType = "DNI" | "RUC" | "NONE";
export type CreditReason = "01" | "02" | "06";

export const CREDIT_REASON_LABEL: Record<CreditReason, string> = { "01": "Anulación de la operación", "02": "Anulación por error en el RUC", "06": "Devolución total" };
/** Boletas desde S/ 700.00 exigen identificar al comprador con DNI (norma SUNAT vigente a la fecha de implementación; verificar). */
export const BOLETA_DNI_THRESHOLD_CENTS = 70_000;
export const MAX_ATTEMPTS = 8;
/** Espera (minutos) antes del siguiente reintento según los intentos ya realizados. */
const BACKOFF_MIN = [1, 5, 15, 60, 180, 360, 720, 1440];

export const isValidDni = (s: string) => /^\d{8}$/.test(s);

/** RUC peruano: 11 dígitos, prefijo 10/15/16/17/20 y dígito verificador (módulo 11). */
export function isValidRuc(s: string): boolean {
  if (!/^\d{11}$/.test(s) || !["10", "15", "16", "17", "20"].includes(s.slice(0, 2))) return false;
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = w.reduce((n, x, i) => n + x * Number(s[i]), 0);
  const d = (11 - (sum % 11)) % 10;
  return d === Number(s[10]);
}

export const clean = (s: unknown, max: number) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export type CustomerInput = { docType?: CustomerDocType; docNumber?: string; name?: string; address?: string; email?: string };
export type Customer = { docType: CustomerDocType; docNumber: string | null; name: string; address: string | null; email: string | null };

/** Valida y normaliza al comprador según el tipo de comprobante. */
export function normalizeCustomer(kind: "BOLETA" | "FACTURA", totalCents: number, c: CustomerInput): { ok: true; value: Customer } | { ok: false; error: string } {
  const number = clean(c.docNumber, 20), name = clean(c.name, 200), address = clean(c.address, 250), email = clean(c.email, 120);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "Correo del comprador inválido" };
  if (kind === "FACTURA") {
    if (!isValidRuc(number)) return { ok: false, error: "RUC inválido: la factura exige un RUC de 11 dígitos con dígito verificador correcto" };
    if (name.length < 3) return { ok: false, error: "Indica la razón social del comprador" };
    if (address.length < 5) return { ok: false, error: "La factura exige la dirección del comprador" };
    return { ok: true, value: { docType: "RUC", docNumber: number, name, address, email: email || null } };
  }
  if ((c.docType ?? "NONE") === "NONE" && !number) {
    if (totalCents >= BOLETA_DNI_THRESHOLD_CENTS) return { ok: false, error: "Las boletas desde S/ 700.00 exigen el DNI del comprador" };
    return { ok: true, value: { docType: "NONE", docNumber: null, name: "CLIENTE VARIOS", address: null, email: email || null } };
  }
  if (!isValidDni(number)) return { ok: false, error: "DNI inválido (8 dígitos)" };
  if (name.length < 2) return { ok: false, error: "Indica el nombre del comprador" };
  return { ok: true, value: { docType: "DNI", docNumber: number, name, address: address || null, email: email || null } };
}

export type DocItem = { description: string; quantity: number; unit: "NIU" | "ZZ"; totalCents: number; taxableCents: number; igvCents: number };
export type SaleLine = { kind: string; description: string; quantity: number; totalCents: number };

const KIND_LABEL: Record<string, string> = {
  PLAYGROUND: "Servicio de ludoteca", PREPAID_PACKAGE: "Cuponera de minutos de ludoteca", DAYCARE_FEE: "Servicio de guardería (mensualidad)",
  POS: "Venta de productos", RESERVATION_PAYMENT: "Servicio de reserva / evento",
};

/** Separa base imponible e IGV de un importe que YA incluye IGV. Entero en céntimos. */
export function splitIgv(totalCents: number, igvBp: number): { taxableCents: number; igvCents: number } {
  const taxableCents = Math.round((totalCents * 10_000) / (10_000 + igvBp));
  return { taxableCents, igvCents: totalCents - taxableCents };
}

/**
 * Ítems del comprobante a partir de la venta. Un comprobante no admite líneas negativas: si la venta tiene descuentos, canje de puntos o
 * saldo de cuponera aplicado, se emite UNA línea consolidada por el neto (el total siempre coincide con lo cobrado).
 */
export function buildDocItems(saleKind: string, lines: SaleLine[], saleTotalCents: number, igvBp: number): { items: DocItem[]; taxableCents: number; igvCents: number; totalCents: number } {
  if (!Number.isSafeInteger(saleTotalCents) || saleTotalCents <= 0) throw new Error("Una venta sin importe a pagar no genera comprobante");
  if (lines.reduce((n, l) => n + l.totalCents, 0) !== saleTotalCents) throw new Error("Los ítems de la venta no suman su total");
  const itemize = lines.every((l) => l.totalCents > 0 && l.quantity > 0 && l.kind !== "COUPON_DISCOUNT" && l.kind !== "POINTS_DISCOUNT" && l.kind !== "PREPAID_CREDIT");
  const base: { description: string; quantity: number; unit: "NIU" | "ZZ"; totalCents: number }[] = itemize
    ? lines.map((l) => ({ description: clean(l.description, 250) || "Servicio", quantity: l.quantity, unit: l.kind === "PRODUCT" ? "NIU" : "ZZ", totalCents: l.totalCents }))
    : [{ description: KIND_LABEL[saleKind] ?? "Servicio", quantity: 1, unit: lines.length > 0 && lines.every((l) => l.kind === "PRODUCT" || l.kind === "COUPON_DISCOUNT" || l.kind === "POINTS_DISCOUNT") ? "NIU" : "ZZ", totalCents: saleTotalCents }];
  const items = base.map((b) => ({ ...b, ...splitIgv(b.totalCents, igvBp) }));
  const taxableCents = items.reduce((n, i) => n + i.taxableCents, 0);
  const igvCents = items.reduce((n, i) => n + i.igvCents, 0);
  return { items, taxableCents, igvCents, totalCents: taxableCents + igvCents };
}

export const docNumber = (serie: string, number: number) => `${serie}-${String(number).padStart(8, "0")}`;
export const KIND_NAME: Record<DocKind, string> = { BOLETA: "Boleta de venta electrónica", FACTURA: "Factura electrónica", CREDIT_NOTE: "Nota de crédito electrónica" };

/** Fecha de reintento: null cuando se agotaron los intentos. */
export function nextAttemptAt(attempts: number, now = new Date()): Date | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  return new Date(now.getTime() + (BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)] ?? 1440) * 60_000 * (attempts <= 0 ? 0 : 1));
}

/** Series: boleta B###, factura F###, y notas de crédito con la misma letra del documento que modifican. */
export function validateSeries(s: { serieBoleta: string; serieFactura: string; serieNcBoleta: string; serieNcFactura: string }): string | null {
  const ok = (v: string, l: string) => new RegExp(`^${l}[A-Z0-9]{3}$`).test(v);
  if (!ok(s.serieBoleta, "B") || !ok(s.serieNcBoleta, "B")) return "Las series de boleta y de su nota de crédito deben empezar con B y tener 4 caracteres (p. ej. B001, BC01)";
  if (!ok(s.serieFactura, "F") || !ok(s.serieNcFactura, "F")) return "Las series de factura y de su nota de crédito deben empezar con F y tener 4 caracteres (p. ej. F001, FC01)";
  if (new Set([s.serieBoleta, s.serieFactura, s.serieNcBoleta, s.serieNcFactura]).size !== 4) return "Las cuatro series deben ser distintas";
  return null;
}

/**
 * La URL del PSE la escribe el tenant: se restringe para evitar SSRF. Nubefact solo en https y dominio nubefact.com.
 * `allowLocal` (pruebas) admite http://127.0.0.1 / localhost fuera de producción.
 */
export function validateApiUrl(raw: string, allowLocal = process.env.NODE_ENV !== "production"): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return "URL del PSE inválida"; }
  if (u.username || u.password) return "La URL no debe contener credenciales";
  if (allowLocal && u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) return null;
  if (u.protocol !== "https:") return "La URL del PSE debe usar https";
  if (!(u.hostname === "nubefact.com" || u.hostname.endsWith(".nubefact.com"))) return "Solo se admiten URLs del dominio nubefact.com";
  return null;
}

/** Enlaces de archivos que se descargan: mismo host del PSE o dominio nubefact.com, https (http solo local). */
export function isAllowedFileUrl(raw: string, apiUrl: string | null, allowLocal = process.env.NODE_ENV !== "production"): boolean {
  try {
    const u = new URL(raw);
    if (allowLocal && u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) return !apiUrl || new URL(apiUrl).host === u.host;
    if (u.protocol !== "https:") return false;
    return u.hostname === "nubefact.com" || u.hostname.endsWith(".nubefact.com") || (!!apiUrl && new URL(apiUrl).hostname === u.hostname);
  } catch { return false; }
}
