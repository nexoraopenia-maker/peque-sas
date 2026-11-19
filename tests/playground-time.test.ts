import { describe, expect, it } from "vitest";
import { amountCents, extraMinutes, light, remainingMs } from "@/lib/playground/time";
import { tenantHasModule } from "@/lib/plans/modules";

const t0 = new Date("2026-01-01T10:00:00Z");
const s = { checkInAt: t0, contractedMinutes: 60, basePriceCents: 2000, extraMinuteCents: 50 };
const at = (min: number, sec = 0) => new Date(t0.getTime() + (min * 60 + sec) * 1000);

describe("semáforo", () => {
  it("verde con tiempo disponible", () => expect(light(s, at(30))).toBe("green"));
  it("amarillo cuando quedan 5 min o menos", () => {
    expect(light(s, at(54, 59))).toBe("green");
    expect(light(s, at(55))).toBe("yellow");
    expect(light(s, at(59, 59))).toBe("yellow");
  });
  it("rojo al agotarse el tiempo", () => {
    expect(light(s, at(60))).toBe("red");
    expect(light(s, at(90))).toBe("red");
  });
});

describe("excedentes e importe", () => {
  it("sin excedente dentro del tiempo", () => {
    expect(extraMinutes(s, at(60))).toBe(0);
    expect(amountCents(s, at(45))).toBe(2000);
  });
  it("cada minuto iniciado se cobra", () => {
    expect(extraMinutes(s, at(60, 1))).toBe(1);
    expect(extraMinutes(s, at(70))).toBe(10);
    expect(amountCents(s, at(70))).toBe(2500);
  });
  it("un reloj adelantado no produce tiempo negativo", () => {
    expect(remainingMs(s, new Date(t0.getTime() - 5000))).toBe(3_600_000);
  });
});

describe("módulos contratados", () => {
  it("valida el JSON de módulos", () => {
    expect(tenantHasModule(["PLAYGROUND"], "PLAYGROUND")).toBe(true);
    expect(tenantHasModule(["PLAYGROUND"], "DAYCARE")).toBe(false);
    expect(tenantHasModule("PLAYGROUND", "PLAYGROUND")).toBe(false);
    expect(tenantHasModule(null, "PLAYGROUND")).toBe(false);
    expect(tenantHasModule(["HACK"], "PLAYGROUND")).toBe(false);
  });
});
