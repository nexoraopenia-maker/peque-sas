import { describe, expect, it } from "vitest";
import { stockDelta } from "@/lib/inventory/stock";

describe("stockDelta", () => {
  it("entrada suma, salida resta", () => {
    expect(stockDelta("IN", 5, 10)).toBe(5);
    expect(stockDelta("OUT", 5, 10)).toBe(-5);
  });
  it("ajuste fija el stock", () => {
    expect(stockDelta("ADJUST", 3, 10)).toBe(-7);
    expect(stockDelta("ADJUST", 0, 10)).toBe(-10);
  });
  it("rechaza saldo negativo y cantidades inválidas", () => {
    expect(() => stockDelta("OUT", 11, 10)).toThrow("Stock insuficiente");
    expect(() => stockDelta("IN", 0, 10)).toThrow();
    expect(() => stockDelta("IN", 1.5, 10)).toThrow();
    expect(() => stockDelta("IN", -1, 10)).toThrow();
  });
});
