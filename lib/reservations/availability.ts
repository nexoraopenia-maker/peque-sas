import { overlaps } from "./calendar";
import { ACTIVE, type ReservationStatus } from "./status";

type R = { startTime: string; endTime: string; attendees: number; status: ReservationStatus; serviceType: string };

/** Cupos libres de un pool en una franja, a partir de reservas ya cargadas (misma regla conservadora que el servicio). */
export function slotRemaining(capacity: number, reservations: R[], service: string, start: string, end: string, occupiedNow = 0): number {
  const used = reservations
    .filter((r) => r.serviceType === service && ACTIVE.includes(r.status) && overlaps(r.startTime, r.endTime, start, end))
    .reduce((n, r) => n + r.attendees, 0);
  return Math.max(0, capacity - used - occupiedNow);
}

export const hourSlots = (from = 8, to = 21) =>
  Array.from({ length: to - from }, (_, i) => [`${String(from + i).padStart(2, "0")}:00`, `${String(from + i + 1).padStart(2, "0")}:00`] as const);
