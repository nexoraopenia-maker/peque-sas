import { describe, expect, it } from "vitest";
import { buildSplit, cashDifference, expectedCash, formatSoles, parseSoles, settleTime, splitTotal } from "@/lib/billing/money";

describe("importes en céntimos", () => {
  it("parseSoles acepta hasta 2 decimales y rechaza el resto", () => {
    expect(parseSoles("12.50")).toBe(1250);
    expect(parseSoles("12,5")).toBe(1250);
    expect(parseSoles("0.07")).toBe(7);
    expect(parseSoles("100")).toBe(10000);
    for (const bad of ["", "-1", "1.234", "abc", "1e3", "1.", ".5", "99999999"]) expect(parseSoles(bad), bad).toBeNull();
  });
  it("sin errores de coma flotante", () => {
    expect(parseSoles("0.10")! + parseSoles("0.20")!).toBe(30);
    expect(formatSoles(1999)).toBe("S/ 19.99");
    expect(formatSoles(-50)).toBe("-S/ 0.50");
    expect(formatSoles(0)).toBe("S/ 0.00");
  });
});

describe("desglose de pagos", () => {
  it("todo con un método", () => expect(buildSplit(1000, "EFECTIVO", null)).toEqual({ cash: 1000, yapePlin: 0, card: 0, transfer: 0 }));
  it("pago mixto: el resto va al segundo método", () => {
    const s = buildSplit(1000, "EFECTIVO", 400, "YAPE_PLIN")!;
    expect(s).toEqual({ cash: 400, yapePlin: 600, card: 0, transfer: 0 });
    expect(splitTotal(s)).toBe(1000);
  });
  it("sin segundo método el parcial es inválido; total 0 es válido", () => {
    expect(buildSplit(1000, "EFECTIVO", 400)).toBeNull();
    expect(buildSplit(0, "EFECTIVO", null)).toEqual({ cash: 0, yapePlin: 0, card: 0, transfer: 0 });
    expect(buildSplit(-1, "EFECTIVO", null)).toBeNull();
    expect(buildSplit(1000, "EFECTIVO", -5, "TARJETA")).toBeNull();
  });
});

describe("arqueo", () => {
  it("efectivo esperado = apertura + ventas en efectivo − devoluciones; electrónicos no suman", () => {
    expect(expectedCash(10000, 25000, 500)).toBe(34500);
    expect(expectedCash(10000, 0)).toBe(10000);
  });
  it("diferencia = declarado − esperado (faltante negativo, sobrante positivo)", () => {
    expect(cashDifference(34000, 34500)).toBe(-500);
    expect(cashDifference(35000, 34500)).toBe(500);
    expect(cashDifference(34500, 34500)).toBe(0);
  });
});

describe("liquidación de ludoteca con cuponera", () => {
  const base = { contractedMinutes: 60, basePriceCents: 2000, extraMinuteCents: 50 };
  it("sin saldo: tarifa + excedente", () => {
    expect(settleTime({ ...base, extraMinutes: 10, prepaidBalance: 0 })).toEqual({ baseCents: 2000, extraCents: 500, prepaidMinutesUsed: 0, prepaidCreditCents: 0, timeDueCents: 2500 });
  });
  it("saldo suficiente cubre todo: se cobra 0", () => {
    const r = settleTime({ ...base, extraMinutes: 10, prepaidBalance: 300 });
    expect(r.prepaidMinutesUsed).toBe(70);
    expect(r.timeDueCents).toBe(0);
    expect(r.prepaidCreditCents).toBe(2500);
  });
  it("saldo parcial: cubre tarifa y se cobra solo el excedente", () => {
    const r = settleTime({ ...base, extraMinutes: 10, prepaidBalance: 60 });
    expect(r.prepaidMinutesUsed).toBe(60);
    expect(r.timeDueCents).toBe(500);
  });
  it("saldo menor a lo contratado: cobra la parte proporcional", () => {
    const r = settleTime({ ...base, extraMinutes: 0, prepaidBalance: 30 });
    expect(r.prepaidMinutesUsed).toBe(30);
    expect(r.prepaidCreditCents).toBe(1000);
    expect(r.timeDueCents).toBe(1000);
  });
  it("nunca usa más saldo que el disponible ni saldo negativo", () => {
    expect(settleTime({ ...base, extraMinutes: 5, prepaidBalance: 1000 }).prepaidMinutesUsed).toBe(65);
    expect(settleTime({ ...base, extraMinutes: 0, prepaidBalance: -50 }).prepaidMinutesUsed).toBe(0);
  });
  it("invariante: cobro + crédito = tarifa + excedente, siempre ≥ 0", () => {
    for (const bal of [0, 1, 17, 59, 60, 61, 90, 500]) for (const x of [0, 1, 7, 30]) {
      const r = settleTime({ ...base, extraMinutes: x, prepaidBalance: bal });
      expect(r.timeDueCents + r.prepaidCreditCents).toBe(r.baseCents + r.extraCents);
      expect(r.timeDueCents).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(r.timeDueCents)).toBe(true);
    }
  });
});
