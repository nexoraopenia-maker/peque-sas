import { limaMinutesOfDay } from "@/lib/utils/date";

export const LATE_TOLERANCE_MINUTES = 10;

export const parseHHMM = (s: string): number | null => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Minutos de tardanza respecto al horario de entrada; 0 dentro de la tolerancia. */
export function lateMinutes(entryTime: string, checkInAt: Date, tolerance = LATE_TOLERANCE_MINUTES): number {
  const entry = parseHHMM(entryTime);
  if (entry === null) return 0;
  const diff = limaMinutesOfDay(checkInAt) - entry;
  return diff > tolerance ? diff : 0;
}
