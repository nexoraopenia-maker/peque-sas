// Aritmética de fechas YYYY-MM-DD sin zonas horarias (UTC puro): no hay desfases por horario.
const ms = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const fmt = (t: number) => new Date(t).toISOString().slice(0, 10);

export const addDays = (d: string, n: number) => fmt(ms(d) + n * 86_400_000);
/** 0 = lunes … 6 = domingo */
export const weekday = (d: string) => (new Date(ms(d)).getUTCDay() + 6) % 7;
export const weekStart = (d: string) => addDays(d, -weekday(d));
export const weekDays = (d: string) => Array.from({ length: 7 }, (_, i) => addDays(weekStart(d), i));
export const addMonths = (month: string, n: number) => {
  const t = +month.slice(0, 4) * 12 + (+month.slice(5, 7) - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};
/** Semanas (lunes a domingo) que cubren el mes; incluye días de relleno de meses vecinos. */
export function monthGrid(month: string): string[][] {
  const first = `${month}-01`;
  const last = addDays(`${addMonths(month, 1)}-01`, -1);
  const weeks: string[][] = [];
  for (let s = weekStart(first); s <= last; s = addDays(s, 7)) weeks.push(weekDays(s));
  return weeks;
}

export const DAY_NAMES = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
export const isTime = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
export const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && fmt(ms(s)) === s;
/** Intervalos semiabiertos [a1,a2) y [b1,b2): tocarse en un extremo NO es solaparse. */
export const overlaps = (a1: string, a2: string, b1: string, b2: string) => a1 < b2 && a2 > b1;
export const minutesBetween = (a: string, b: string) => (+b.slice(0, 2) * 60 + +b.slice(3)) - (+a.slice(0, 2) * 60 + +a.slice(3));
