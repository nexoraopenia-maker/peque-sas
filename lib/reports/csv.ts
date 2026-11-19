// CSV seguro (RFC 4180, UTF-8 con BOM para Excel). Texto que empieza con = + - @ se neutraliza (inyección de fórmulas).
export type Cell = string | number | null | undefined;
const FORMULA = /^[=+\-@\t\r]/;
// Un número negativo puro ("-2260.49", "-11.30 %") no es una fórmula: debe quedar tal cual para no falsear pérdidas en el reporte
const PLAIN_NEGATIVE = /^-\d+(\.\d+)?( %)?$/;
export function csvCell(v: Cell): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(v);
  let s = FORMULA.test(v) && !PLAIN_NEGATIVE.test(v) ? `'${v}` : v;
  if (/[",\r\n;]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}
export const toCsv = (rows: Cell[][]) => "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
/** Céntimos → "12.50" (decimal con punto, apto para hojas de cálculo). */
export const centsToDecimal = (c: number) => `${c < 0 ? "-" : ""}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, "0")}`;
