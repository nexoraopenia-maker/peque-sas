// Lógica monetaria PURA. Todo en céntimos (enteros). Sin Float: las únicas divisiones usan Math.round sobre enteros.
export type Method = "EFECTIVO" | "YAPE_PLIN" | "TARJETA" | "TRANSFERENCIA";
export const METHODS: Method[] = ["EFECTIVO", "YAPE_PLIN", "TARJETA", "TRANSFERENCIA"];
export const METHOD_LABEL: Record<Method, string> = { EFECTIVO: "Efectivo", YAPE_PLIN: "Yape/Plin", TARJETA: "Tarjeta", TRANSFERENCIA: "Transferencia" };

export type Split = { cash: number; yapePlin: number; card: number; transfer: number };
const KEY: Record<Method, keyof Split> = { EFECTIVO: "cash", YAPE_PLIN: "yapePlin", TARJETA: "card", TRANSFERENCIA: "transfer" };

export const isCents = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n);

/** "12.50" / "12,5" → 1250. Devuelve null si no es un importe válido con ≤2 decimales. */
export function parseSoles(input: string): number | null {
  const t = input.trim().replace(",", ".");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null;
  const [i, d = ""] = t.split(".");
  return Number(i) * 100 + Number(d.padEnd(2, "0"));
}
export const formatSoles = (cents: number) => `${cents < 0 ? "-" : ""}S/ ${(Math.abs(cents) / 100).toFixed(2)}`;

/**
 * Reparte el total entre uno o dos métodos. `firstAmountCents` null/≥total = todo con el primer método.
 * Si es menor, el resto va al segundo método (obligatorio). Devuelve null si es inconsistente.
 */
export function buildSplit(total: number, first: Method, firstAmountCents: number | null, second?: Method | null): Split | null {
  if (!isCents(total) || total < 0) return null;
  const s: Split = { cash: 0, yapePlin: 0, card: 0, transfer: 0 };
  const amt = firstAmountCents == null || firstAmountCents >= total ? total : firstAmountCents;
  if (amt < 0) return null;
  s[KEY[first]] += amt;
  const rest = total - amt;
  if (rest > 0) {
    if (!second) return null;
    s[KEY[second]] += rest;
  }
  return s;
}
export const splitTotal = (s: Split) => s.cash + s.yapePlin + s.card + s.transfer;

/** Efectivo esperado en caja: apertura + ventas en efectivo − devoluciones en efectivo − gastos pagados del cajón. Los pagos electrónicos NO suman. */
export const expectedCash = (openingBalanceCents: number, cashSalesCents: number, cashRefundsCents = 0, cashExpensesCents = 0) =>
  openingBalanceCents + cashSalesCents - cashRefundsCents - cashExpensesCents;
export const cashDifference = (declaredCashCents: number, expectedCashCents: number) => declaredCashCents - expectedCashCents;

export type TimeSettlementInput = {
  contractedMinutes: number; extraMinutes: number; basePriceCents: number; extraMinuteCents: number; prepaidBalance: number;
};
export type TimeSettlement = {
  baseCents: number; extraCents: number; prepaidMinutesUsed: number; prepaidCreditCents: number; timeDueCents: number;
};

/**
 * Liquidación del tiempo de ludoteca al hacer la salida.
 * El saldo prepago cubre primero los minutos contratados (a valor proporcional de la tarifa base) y luego los excedentes
 * (a su tarifa por minuto). Se cobra en caja solo lo no cubierto. Nunca usa más saldo del disponible.
 */
export function settleTime(i: TimeSettlementInput): TimeSettlement {
  const { contractedMinutes: c, extraMinutes: x, basePriceCents: base, extraMinuteCents: em } = i;
  const total = c + x;
  const used = Math.max(0, Math.min(i.prepaidBalance, total));
  const coveredBase = Math.min(used, c);
  const coveredExtra = used - coveredBase;
  const baseCredit = c > 0 ? Math.round((base * coveredBase) / c) : 0;
  const extraCredit = coveredExtra * em;
  const baseCents = base;
  const extraCents = x * em;
  const prepaidCreditCents = baseCredit + extraCredit;
  return { baseCents, extraCents, prepaidMinutesUsed: used, prepaidCreditCents, timeDueCents: baseCents + extraCents - prepaidCreditCents };
}
