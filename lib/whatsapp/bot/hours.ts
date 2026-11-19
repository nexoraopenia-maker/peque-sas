import { z } from "zod";
import { weekday } from "@/lib/reservations/calendar";
import { parseHHMM } from "@/lib/daycare/time";
import { limaDate, limaMinutesOfDay } from "@/lib/utils/date";

/** Horario semanal de atención (hora de Lima). day: 0 = lunes … 6 = domingo. Sin horario configurado = siempre abierto. */
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const hoursSchema = z.array(z.object({ day: z.number().int().min(0).max(6), open: hhmm, close: hhmm })).max(28)
  .refine((a) => a.every((h) => h.open < h.close), { message: "La hora de cierre debe ser posterior a la de apertura" });
export type Hours = z.infer<typeof hoursSchema>;

export const parseHours = (json: unknown): Hours => { const r = hoursSchema.safeParse(json); return r.success ? r.data : []; };

export function isOpenNow(hours: Hours, now = new Date()): boolean {
  if (!hours.length) return true;
  const day = weekday(limaDate(now)), m = limaMinutesOfDay(now);
  return hours.some((h) => h.day === day && parseHHMM(h.open)! <= m && m < parseHHMM(h.close)!);
}

const DAYS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
export const describeHours = (hours: Hours): string =>
  !hours.length ? "Horario no configurado" : [...hours].sort((a, b) => a.day - b.day || a.open.localeCompare(b.open)).map((h) => `${DAYS[h.day]} ${h.open}–${h.close}`).join("; ");

/** Del formulario (open_0/close_0 … open_6/close_6) al arreglo; filas vacías = cerrado ese día. */
export function hoursFromForm(get: (k: string) => string): Hours {
  const out: Hours = [];
  for (let d = 0; d < 7; d++) { const o = get(`open_${d}`).trim(), c = get(`close_${d}`).trim(); if (o && c) out.push({ day: d, open: o, close: c }); }
  return out;
}
