// Perú no tiene horario de verano (UTC-5 fijo). Todas las fechas "de día" se guardan como YYYY-MM-DD en hora de Lima.
const TZ = "America/Lima";

export function limaDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Minutos desde medianoche (hora de Lima). */
export function limaMinutesOfDay(d: Date): number {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  return Number(p.find((x) => x.type === "hour")!.value) * 60 + Number(p.find((x) => x.type === "minute")!.value);
}

export const isDateString = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
export const isMonthString = (s: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
