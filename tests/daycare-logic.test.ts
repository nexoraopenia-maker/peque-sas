import { describe, expect, it } from "vitest";
import { limaDate, limaMinutesOfDay, daysInMonth, isDateString } from "@/lib/utils/date";
import { lateMinutes, parseHHMM } from "@/lib/daycare/time";
import { describeLog, logInputSchema } from "@/lib/daycare/log";
import { hasPermission } from "@/lib/rbac/permissions";

describe("fechas de Lima (UTC-5)", () => {
  it("23:30 en Lima ya es el día siguiente en UTC pero sigue siendo el mismo día local", () => {
    expect(limaDate(new Date("2026-03-11T04:30:00Z"))).toBe("2026-03-10"); // 23:30 del 10 en Lima
    expect(limaDate(new Date("2026-03-11T05:00:00Z"))).toBe("2026-03-11"); // 00:00 del 11
  });
  it("minutos del día y mes", () => {
    expect(limaMinutesOfDay(new Date("2026-03-10T13:05:00Z"))).toBe(8 * 60 + 5);
    expect(daysInMonth("2026-02")).toBe(28);
    expect(daysInMonth("2028-02")).toBe(29);
    expect(isDateString("2026-13-40")).toBe(false);
  });
});

describe("tardanza", () => {
  const at = (hhmmLima: string) => new Date(`2026-03-10T${String(Number(hhmmLima.slice(0, 2)) + 5).padStart(2, "0")}:${hhmmLima.slice(3)}:00Z`);
  it("dentro de la tolerancia no es tardanza", () => {
    expect(lateMinutes("08:00", at("08:10"))).toBe(0);
    expect(lateMinutes("08:00", at("07:30"))).toBe(0);
  });
  it("fuera de tolerancia cuenta todos los minutos", () => {
    expect(lateMinutes("08:00", at("08:11"))).toBe(11);
    expect(lateMinutes("08:00", at("09:00"))).toBe(60);
  });
  it("horario inválido", () => {
    expect(parseHHMM("25:00")).toBeNull();
    expect(lateMinutes("xx", at("09:00"))).toBe(0);
  });
});

describe("registros de la pizarra", () => {
  it("valida subtipo y cantidad por tipo", () => {
    expect(logInputSchema.safeParse({ kind: "MEAL", childId: "c", subtype: "LUNCH", level: "ALL" }).success).toBe(true);
    expect(logInputSchema.safeParse({ kind: "MEAL", childId: "c", subtype: "DINNER", level: "ALL" }).success).toBe(false);
    expect(logInputSchema.safeParse({ kind: "MEAL", childId: "c", subtype: "LUNCH" }).success).toBe(false);
    expect(logInputSchema.safeParse({ kind: "DIAPER", childId: "c", subtype: "WET" }).success).toBe(true);
    expect(logInputSchema.safeParse({ kind: "MOOD", childId: "c", subtype: "HAPPY" }).success).toBe(true);
    expect(logInputSchema.safeParse({ kind: "HACK", childId: "c" }).success).toBe(false);
  });
  it("mensajes para padres", () => {
    expect(describeLog({ kind: "MEAL", subtype: "LUNCH", level: "MOST" })).toBe("Almuerzo: comió casi todo");
    expect(describeLog({ kind: "DIAPER", subtype: "BOTH" })).toBe("Cambio de pañal: mojado y sucio");
    const a = new Date("2026-03-10T18:00:00Z");
    expect(describeLog({ kind: "NAP", occurredAt: a, endedAt: new Date(a.getTime() + 90 * 60000) })).toBe("Siesta de 90 min");
  });
});

describe("permisos de guardería", () => {
  it("la pizarra es de profesoras y administración, no de recepción", () => {
    expect(hasPermission("TEACHER", "teacherboard:use")).toBe(true);
    expect(hasPermission("RECEPTION", "teacherboard:use")).toBe(false);
  });
  it("las matrículas no las gestionan las profesoras", () => {
    expect(hasPermission("TEACHER", "daycare:manage")).toBe(false);
    expect(hasPermission("RECEPTION", "daycare:manage")).toBe(true);
    expect(hasPermission("TEACHER", "daycare:attendance")).toBe(true);
  });
});
