// Lógica pura de reportes financieros (sin BD). Todo en céntimos; fechas = día contable de Lima (YYYY-MM-DD).
export type Granularity = "DAY" | "WEEK" | "MONTH";
export const GRANULARITIES: Granularity[] = ["DAY", "WEEK", "MONTH"];
export const GRANULARITY_LABEL: Record<Granularity, string> = { DAY: "Diario", WEEK: "Semanal", MONTH: "Mensual" };
export const MAX_RANGE_DAYS = 366;

const MS = 86_400_000;
const toNum = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / MS);
const fromNum = (n: number) => new Date(n * MS).toISOString().slice(0, 10);
export const addDaysStr = (d: string, n: number) => fromNum(toNum(d) + n);
export const daysBetween = (from: string, to: string) => toNum(to) - toNum(from) + 1;

/** Lunes de la semana de la fecha (semana ISO, lunes a domingo). */
export function mondayOf(d: string): string {
  const dow = new Date(`${d}T00:00:00Z`).getUTCDay(); // 0 = domingo
  return addDaysStr(d, -((dow + 6) % 7));
}
export function bucketKey(d: string, g: Granularity): string {
  return g === "DAY" ? d : g === "WEEK" ? mondayOf(d) : d.slice(0, 7);
}
export function bucketLabel(key: string, g: Granularity): string {
  if (g === "DAY") return key;
  if (g === "MONTH") return key;
  return `Semana del ${key} al ${addDaysStr(key, 6)}`;
}

export function validateRange(from: string, to: string): string | null {
  const ok = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
  if (!ok(from) || !ok(to)) return "Fechas inválidas";
  if (to < from) return "La fecha final no puede ser anterior a la inicial";
  if (daysBetween(from, to) > MAX_RANGE_DAYS) return `El rango máximo es de ${MAX_RANGE_DAYS} días`;
  return null;
}

/** Límites [inicio, fin] del rango en hora de Lima (UTC-5 fijo, sin horario de verano). */
export const rangeBounds = (from: string, to: string) => ({ start: new Date(`${from}T00:00:00.000-05:00`), end: new Date(`${to}T23:59:59.999-05:00`) });

/** Margen en puntos básicos (1250 = 12.50 %) sobre los ingresos; null si no hay ingresos. Entero: sin Float acumulado. */
export const marginBp = (incomeCents: number, profitCents: number): number | null => (incomeCents > 0 ? Math.round((profitCents * 10_000) / incomeCents) : null);
export const formatMargin = (bp: number | null) => (bp === null ? "—" : `${(bp / 100).toFixed(2)} %`);

export type DayAmounts = { day: string; incomeCents: number; expenseCents: number };
export type Period = { key: string; label: string; incomeCents: number; expenseCents: number; profitCents: number; marginBp: number | null };

/** Agrupa montos diarios en periodos contiguos (incluye periodos sin movimiento) cubriendo todo el rango. */
export function buildPeriods(rows: DayAmounts[], from: string, to: string, g: Granularity): Period[] {
  const acc = new Map<string, { i: number; e: number }>();
  for (let n = toNum(from); n <= toNum(to); n++) { const k = bucketKey(fromNum(n), g); if (!acc.has(k)) acc.set(k, { i: 0, e: 0 }); }
  for (const r of rows) {
    if (r.day < from || r.day > to) continue;
    const a = acc.get(bucketKey(r.day, g))!; a.i += r.incomeCents; a.e += r.expenseCents;
  }
  return [...acc.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, a]) => ({
    key, label: bucketLabel(key, g), incomeCents: a.i, expenseCents: a.e, profitCents: a.i - a.e, marginBp: marginBp(a.i, a.i - a.e),
  }));
}
