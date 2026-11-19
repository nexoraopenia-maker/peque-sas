export type ReservationStatus = "PENDING" | "CONFIRMED" | "COMPLETED" | "CANCELLED" | "NO_SHOW";
export type ReservationService = "LUDOTECA" | "CUMPLEANOS" | "GUARDERIA" | "EVENTO";

/** Estados que ocupan capacidad/espacio y admiten cobros. */
export const ACTIVE: ReservationStatus[] = ["PENDING", "CONFIRMED"];

const NEXT: Record<ReservationStatus, ReservationStatus[]> = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["COMPLETED", "CANCELLED", "NO_SHOW"],
  COMPLETED: [], CANCELLED: [], NO_SHOW: [],
};
export const canTransition = (from: ReservationStatus, to: ReservationStatus) => NEXT[from].includes(to);
export const isActive = (s: ReservationStatus) => ACTIVE.includes(s);

/** Cumpleaños y eventos usan un espacio exclusivo; ludoteca y guardería comparten un aforo. */
export const needsSpace = (s: ReservationService) => s === "CUMPLEANOS" || s === "EVENTO";

export const SERVICE_LABEL: Record<ReservationService, string> = { LUDOTECA: "Ludoteca", CUMPLEANOS: "Cumpleaños", GUARDERIA: "Guardería", EVENTO: "Evento" };
export const STATUS_LABEL: Record<ReservationStatus, string> = { PENDING: "Pendiente", CONFIRMED: "Confirmada", COMPLETED: "Completada", CANCELLED: "Cancelada", NO_SHOW: "No asistió" };

export const balanceCents = (r: { totalAmountCents: number; advancePaidCents: number }) => r.totalAmountCents - r.advancePaidCents;
