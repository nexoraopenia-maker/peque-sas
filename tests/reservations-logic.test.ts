import { describe, expect, it } from "vitest";
import { ACTIVE, balanceCents, canTransition, needsSpace } from "@/lib/reservations/status";
import { addDays, addMonths, isDate, isTime, minutesBetween, monthGrid, overlaps, weekDays, weekStart, weekday } from "@/lib/reservations/calendar";

describe("estados de reserva", () => {
  it("transiciones válidas", () => {
    expect(canTransition("PENDING", "CONFIRMED")).toBe(true);
    expect(canTransition("CONFIRMED", "COMPLETED")).toBe(true);
    expect(canTransition("CONFIRMED", "NO_SHOW")).toBe(true);
    expect(canTransition("CONFIRMED", "CANCELLED")).toBe(true);
  });
  it("transiciones inválidas y estados terminales", () => {
    expect(canTransition("PENDING", "COMPLETED")).toBe(false);
    expect(canTransition("PENDING", "NO_SHOW")).toBe(false);
    for (const t of ["COMPLETED", "CANCELLED", "NO_SHOW"] as const) for (const to of ["PENDING", "CONFIRMED", "COMPLETED", "CANCELLED", "NO_SHOW"] as const) expect(canTransition(t, to)).toBe(false);
  });
  it("solo PENDING y CONFIRMED ocupan capacidad", () => expect(ACTIVE).toEqual(["PENDING", "CONFIRMED"]));
  it("cumpleaños y eventos requieren espacio; ludoteca y guardería no", () => {
    expect(needsSpace("CUMPLEANOS")).toBe(true); expect(needsSpace("EVENTO")).toBe(true);
    expect(needsSpace("LUDOTECA")).toBe(false); expect(needsSpace("GUARDERIA")).toBe(false);
  });
  it("saldo = total − pagado", () => expect(balanceCents({ totalAmountCents: 50000, advancePaidCents: 15000 })).toBe(35000));
});

describe("calendario", () => {
  it("días y semanas (lunes a domingo)", () => {
    expect(weekday("2026-03-09")).toBe(0); // lunes
    expect(weekday("2026-03-15")).toBe(6); // domingo
    expect(weekStart("2026-03-15")).toBe("2026-03-09");
    expect(weekDays("2026-03-11")).toHaveLength(7);
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });
  it("meses", () => {
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
  });
  it("cuadrícula mensual completa", () => {
    const g = monthGrid("2026-03");
    expect(g.every((w) => w.length === 7)).toBe(true);
    expect(g[0]![0]).toBe("2026-02-23");
    expect(g.flat()).toContain("2026-03-31");
    expect(g.at(-1)!.at(-1)).toBe("2026-04-05");
    expect(monthGrid("2026-02")).toHaveLength(5); // 1 feb 2026 es domingo: la primera semana empieza el lunes 26 de enero
  });
  it("validación de fecha y hora", () => {
    expect(isDate("2026-02-30")).toBe(false); expect(isDate("2026-02-28")).toBe(true);
    expect(isTime("24:00")).toBe(false); expect(isTime("09:30")).toBe(true); expect(isTime("9:30")).toBe(false);
  });
  it("solapamiento semiabierto: tocarse no es solaparse", () => {
    expect(overlaps("10:00", "12:00", "11:00", "13:00")).toBe(true);
    expect(overlaps("10:00", "12:00", "12:00", "14:00")).toBe(false);
    expect(overlaps("10:00", "12:00", "08:00", "10:00")).toBe(false);
    expect(overlaps("10:00", "12:00", "10:30", "11:00")).toBe(true);
    expect(minutesBetween("10:00", "12:30")).toBe(150);
  });
});

import { hourSlots, slotRemaining } from "@/lib/reservations/availability";
describe("cupos del calendario", () => {
  const r = (start: string, end: string, attendees: number, status: "PENDING" | "CONFIRMED" | "CANCELLED" = "CONFIRMED", serviceType = "LUDOTECA") => ({ startTime: start, endTime: end, attendees, status, serviceType });
  it("resta solo reservas activas, del mismo servicio y solapadas", () => {
    const list = [r("10:00", "12:00", 6), r("11:00", "13:00", 2, "PENDING"), r("10:00", "12:00", 9, "CANCELLED"), r("10:00", "12:00", 9, "CONFIRMED", "GUARDERIA"), r("12:00", "13:00", 3)];
    expect(slotRemaining(10, list, "LUDOTECA", "10:00", "11:00")).toBe(4);
    expect(slotRemaining(10, list, "LUDOTECA", "11:00", "12:00")).toBe(2);
    expect(slotRemaining(10, list, "LUDOTECA", "12:00", "13:00")).toBe(5);
    expect(slotRemaining(10, list, "LUDOTECA", "14:00", "15:00")).toBe(10);
  });
  it("nunca negativo y descuenta a los presentes ahora", () => {
    expect(slotRemaining(5, [r("10:00", "11:00", 9)], "LUDOTECA", "10:00", "11:00")).toBe(0);
    expect(slotRemaining(10, [], "LUDOTECA", "10:00", "11:00", 3)).toBe(7);
  });
  it("franjas horarias", () => { expect(hourSlots(8, 10)).toEqual([["08:00", "09:00"], ["09:00", "10:00"]]); });
});
