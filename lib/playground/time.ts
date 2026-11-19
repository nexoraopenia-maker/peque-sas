// Lógica pura: todo se calcula con timestamps persistidos (checkInAt/checkOutAt), nunca con un cronómetro del navegador.
export type Light = "green" | "yellow" | "red";

const MIN = 60_000;
export const WARNING_MINUTES = 5;

export type SessionTimes = { checkInAt: Date; contractedMinutes: number };

export function elapsedMs(s: SessionTimes, now: Date): number {
  return Math.max(0, now.getTime() - s.checkInAt.getTime());
}

export function remainingMs(s: SessionTimes, now: Date): number {
  return s.contractedMinutes * MIN - elapsedMs(s, now);
}

/** Verde: tiempo disponible; amarillo: quedan ≤5 min; rojo: tiempo excedido. */
export function light(s: SessionTimes, now: Date): Light {
  const r = remainingMs(s, now);
  if (r <= 0) return "red";
  return r <= WARNING_MINUTES * MIN ? "yellow" : "green";
}

/** Minutos excedidos, redondeados hacia arriba (cada minuto iniciado se cobra). */
export function extraMinutes(s: SessionTimes, now: Date): number {
  const over = -remainingMs(s, now);
  return over <= 0 ? 0 : Math.ceil(over / MIN);
}

export function amountCents(s: SessionTimes & { basePriceCents: number; extraMinuteCents: number }, now: Date): number {
  return s.basePriceCents + extraMinutes(s, now) * s.extraMinuteCents;
}

export function formatDuration(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  const total = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60);
  return `${sign}${h > 0 ? `${h}h ` : ""}${m}m`;
}
