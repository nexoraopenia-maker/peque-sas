import { describe, expect, it } from "vitest";
import { CASHIER_LIMIT_CENTS, checkExpenseRules } from "@/lib/expenses/pure";
import { addDaysStr, bucketKey, buildPeriods, daysBetween, formatMargin, marginBp, mondayOf, rangeBounds, validateRange } from "@/lib/reports/pure";
import { centsToDecimal, csvCell, toCsv } from "@/lib/reports/csv";
import { renderPdf, wrap } from "@/lib/reports/pdf";
import { expectedCash, cashDifference } from "@/lib/billing/money";
import { hasPermission } from "@/lib/rbac/permissions";

const base = { canManage: false, category: "OPERATING_SUPPLIES", source: "CASH_DRAWER", amountCents: 5000, expenseDate: "2026-11-18", today: "2026-11-18" } as const;

describe("reglas de gastos por rol", () => {
  it("el cajero registra insumos del cajón de hoy hasta el tope", () => {
    expect(checkExpenseRules(base)).toBeNull();
    expect(checkExpenseRules({ ...base, amountCents: CASHIER_LIMIT_CENTS })).toBeNull();
    expect(checkExpenseRules({ ...base, amountCents: CASHIER_LIMIT_CENTS + 1 })).toMatch(/mayores/);
  });
  it("el tope del cajero es configurable (por defecto S/ 100.00)", () => {
    expect(checkExpenseRules({ ...base, amountCents: 20_000, cashierLimitCents: 25_000 })).toBeNull();
    expect(checkExpenseRules({ ...base, amountCents: 25_001, cashierLimitCents: 25_000 })).toMatch(/S\/ 250\.00/);
    expect(checkExpenseRules({ ...base, amountCents: 1, cashierLimitCents: 0 })).toMatch(/S\/ 0\.00/);
    expect(checkExpenseRules({ ...base, amountCents: CASHIER_LIMIT_CENTS + 1 })).toMatch(/S\/ 100\.00/);
    expect(checkExpenseRules({ ...base, canManage: true, amountCents: 99_999_999, cashierLimitCents: 0 })).toBeNull();
  });
  it("el cajero NO registra otras categorías, otros orígenes ni fechas pasadas", () => {
    for (const category of ["PERSONNEL", "RENT_UTILITIES", "MARKETING_MISC"] as const) expect(checkExpenseRules({ ...base, category })).toMatch(/propietario/);
    for (const source of ["CASH_OTHER", "YAPE_PLIN", "CARD", "TRANSFER"] as const) expect(checkExpenseRules({ ...base, source })).toMatch(/cajón/);
    expect(checkExpenseRules({ ...base, expenseDate: "2026-11-17" })).toMatch(/de hoy/);
  });
  it("OWNER/ADMIN registran cualquier categoría, origen y monto, con fecha pasada", () => {
    expect(checkExpenseRules({ ...base, canManage: true, category: "PERSONNEL", source: "TRANSFER", amountCents: 2_500_000, expenseDate: "2026-10-01" })).toBeNull();
  });
  it("rechaza montos no positivos o no enteros, fechas futuras, inválidas o antiguas", () => {
    for (const amountCents of [0, -5, 10.5, NaN]) expect(checkExpenseRules({ ...base, canManage: true, amountCents })).toMatch(/mayor a cero/);
    expect(checkExpenseRules({ ...base, canManage: true, expenseDate: "2026-11-19" })).toMatch(/futura/);
    expect(checkExpenseRules({ ...base, canManage: true, expenseDate: "2026-13-45" })).toMatch(/inválida/);
    expect(checkExpenseRules({ ...base, canManage: true, expenseDate: "2024-01-01" })).toMatch(/antigua/);
  });
  it("permisos: cajero registra; solo OWNER/ADMIN administran y ven reportes; TEACHER nada", () => {
    expect(hasPermission("RECEPTION", "expenses:record")).toBe(true);
    for (const p of ["expenses:manage", "reports:view"] as const) { expect(hasPermission("RECEPTION", p)).toBe(false); expect(hasPermission("TEACHER", p)).toBe(false); expect(hasPermission("OWNER", p)).toBe(true); expect(hasPermission("ADMIN", p)).toBe(true); }
    expect(hasPermission("TEACHER", "expenses:record")).toBe(false);
  });
});

describe("efectivo esperado con gastos del cajón", () => {
  it("resta los gastos y mantiene la diferencia", () => {
    expect(expectedCash(5000, 20000, 0, 3000)).toBe(22000);
    expect(expectedCash(5000, 20000)).toBe(25000);
    expect(cashDifference(22000, expectedCash(5000, 20000, 0, 3000))).toBe(0);
  });
});

describe("periodos y utilidad", () => {
  it("semana ISO (lunes a domingo) y mes", () => {
    expect(mondayOf("2026-11-18")).toBe("2026-11-16");     // miércoles
    expect(mondayOf("2026-11-16")).toBe("2026-11-16");     // lunes
    expect(mondayOf("2026-11-22")).toBe("2026-11-16");     // domingo
    expect(mondayOf("2026-11-23")).toBe("2026-11-23");
    expect(bucketKey("2026-11-18", "MONTH")).toBe("2026-11");
    expect(addDaysStr("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetween("2026-11-01", "2026-11-30")).toBe(30);
  });
  it("agrupa, incluye periodos vacíos y calcula utilidad y margen enteros", () => {
    const rows = [{ day: "2026-11-16", incomeCents: 10000, expenseCents: 2500 }, { day: "2026-11-18", incomeCents: 5000, expenseCents: 0 }, { day: "2026-11-24", incomeCents: 0, expenseCents: 4000 }];
    const w = buildPeriods(rows, "2026-11-16", "2026-11-30", "WEEK");
    expect(w.map((p) => [p.key, p.incomeCents, p.expenseCents, p.profitCents])).toEqual([["2026-11-16", 15000, 2500, 12500], ["2026-11-23", 0, 4000, -4000], ["2026-11-30", 0, 0, 0]]);   // el 30/11 es lunes: abre otra semana (vacía)
    expect(w[0]!.marginBp).toBe(8333); expect(w[1]!.marginBp).toBeNull();
    expect(buildPeriods(rows, "2026-11-16", "2026-11-18", "DAY").map((p) => p.key)).toEqual(["2026-11-16", "2026-11-17", "2026-11-18"]);
    const m = buildPeriods(rows, "2026-11-01", "2026-12-05", "MONTH"); expect(m.map((p) => p.key)).toEqual(["2026-11", "2026-12"]);
    expect(m[0]!.profitCents).toBe(8500);
  });
  it("ignora días fuera del rango y la suma por periodos = total", () => {
    const rows = [{ day: "2026-10-31", incomeCents: 999, expenseCents: 0 }, { day: "2026-11-02", incomeCents: 700, expenseCents: 200 }];
    const p = buildPeriods(rows, "2026-11-01", "2026-11-03", "DAY");
    expect(p.reduce((n, x) => n + x.incomeCents, 0)).toBe(700);
  });
  it("margen: sin ingresos no hay margen; pérdida es negativa", () => {
    expect(marginBp(0, -500)).toBeNull(); expect(marginBp(10000, -2500)).toBe(-2500); expect(formatMargin(1250)).toBe("12.50 %"); expect(formatMargin(null)).toBe("—");
  });
  it("valida rangos (orden, formato y máximo 366 días) y usa límites de Lima", () => {
    expect(validateRange("2026-11-01", "2026-11-30")).toBeNull();
    expect(validateRange("2026-11-30", "2026-11-01")).toMatch(/anterior/);
    expect(validateRange("2026-1-1", "2026-11-01")).toMatch(/inválidas/);
    expect(validateRange("2025-01-01", "2026-11-01")).toMatch(/máximo/);
    const b = rangeBounds("2026-11-18", "2026-11-18");
    expect(b.start.toISOString()).toBe("2026-11-18T05:00:00.000Z"); expect(b.end.toISOString()).toBe("2026-11-19T04:59:59.999Z");
  });
});

describe("CSV", () => {
  it("escapa comillas, comas y saltos; neutraliza fórmulas; no toca números", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""'); expect(csvCell("l1\nl2")).toBe('"l1\nl2"'); expect(csvCell(null)).toBe(""); expect(csvCell(-5)).toBe("-5");
    expect(csvCell("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\""); expect(csvCell("+1")).toBe("'+1"); expect(csvCell("@cmd")).toBe("'@cmd"); expect(csvCell("-2+3")).toBe("'-2+3");
  });
  it("los importes negativos (pérdidas) NO se alteran, pero el texto con forma de fórmula sí", () => {
    expect(csvCell("-2260.49")).toBe("-2260.49"); expect(csvCell("-11.30 %")).toBe("-11.30 %"); expect(csvCell("-0.05")).toBe("-0.05");
    expect(csvCell("-1+2")).toBe("'-1+2"); expect(csvCell("-2260.49;=1")).toContain("'"); expect(csvCell("--5")).toBe("'--5"); expect(csvCell("-cmd|calc")).toBe("'-cmd|calc");
  });
  it("BOM, CRLF y decimales exactos", () => {
    const c = toCsv([["a", 1], ["ñ", "b"]]); expect(c.startsWith("﻿")).toBe(true); expect(c).toBe("﻿a,1\r\nñ,b\r\n");
    expect([0, 5, 100, 12345, -250, -5].map(centsToDecimal)).toEqual(["0.00", "0.05", "1.00", "123.45", "-2.50", "-0.05"]);
  });
});

describe("PDF", () => {
  it("estructura válida: cabecera, xref con desplazamientos exactos y EOF", () => {
    const pdf = renderPdf("Prueba ñ", [{ text: "Línea con (paréntesis) y \\ barra, acentos áéíóú ñ ¿?", bold: true }, { text: "x" }]);
    const s = pdf.toString("latin1");
    expect(s.startsWith("%PDF-1.4")).toBe(true); expect(s.trimEnd().endsWith("%%EOF")).toBe(true);
    const start = Number(/startxref\n(\d+)\n/.exec(s)![1]); expect(s.slice(start, start + 4)).toBe("xref");
    const entries = [...s.slice(start).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
    entries.forEach((off, i) => expect(s.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    expect(s).toContain("\\(par"); expect(s).toContain("/Count 1");
  });
  it("pagina cuando hay muchas líneas y parte líneas largas", () => {
    const many = renderPdf("Largo", Array.from({ length: 150 }, (_, i) => ({ text: `fila ${i}` }))).toString("latin1");
    expect(Number(/\/Count (\d+)/.exec(many)![1])).toBe(3);
    expect(wrap("palabra ".repeat(40)).every((l) => l.length <= 95)).toBe(true);
    expect(wrap("x".repeat(200)).length).toBe(3);
  });
});
