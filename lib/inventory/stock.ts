export type MovementType = "IN" | "OUT" | "ADJUST";

/** Variación de stock para un movimiento. ADJUST fija el stock a `quantity`. Lanza si el resultado sería negativo. */
export function stockDelta(type: MovementType, quantity: number, current: number): number {
  if (!Number.isInteger(quantity) || quantity < 0) throw new Error("Cantidad inválida");
  if (type !== "ADJUST" && quantity === 0) throw new Error("Cantidad inválida");
  const delta = type === "IN" ? quantity : type === "OUT" ? -quantity : quantity - current;
  if (current + delta < 0) throw new Error("Stock insuficiente");
  return delta;
}
