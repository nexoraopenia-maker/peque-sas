import "server-only";
import { centsToDecimal, toCsv, type Cell } from "./csv";
import { PDF_COLS, renderPdf, type PdfLine } from "./pdf";
import { formatMargin, GRANULARITY_LABEL } from "./pure";
import type { Report } from "./service";
import { CATEGORY_LABEL, SOURCE_LABEL, type ExpenseCategory, type ExpenseSource } from "@/lib/expenses/pure";

const KIND_LABEL: Record<string, string> = { PLAYGROUND: "Ludoteca", PREPAID_PACKAGE: "Cuponera", DAYCARE_FEE: "Mensualidad", POS: "Venta de productos", RESERVATION_PAYMENT: "Reservas" };
const M = centsToDecimal;

export type ExpenseRow = { expenseDate: string; category: ExpenseCategory; source: ExpenseSource; description: string; supplier: string | null; reference: string | null; amountCents: number; voidedAt: Date | null };

export function summaryCsv(r: Report, tenantName: string): string {
  const rows: Cell[][] = [
    ["Reporte financiero", tenantName], ["Desde", r.from], ["Hasta", r.to], ["Periodicidad", GRANULARITY_LABEL[r.granularity]], ["Moneda", "PEN (S/)"], [],
    ["RESUMEN"], ["Ingresos (cobrados)", M(r.income.totalCents)], ["Ventas", r.income.salesCount], ["Descuentos otorgados", M(r.income.discountsCents)],
    ["Egresos", M(r.expenses.totalCents)], ["Utilidad", M(r.profitCents)], ["Margen", formatMargin(r.marginBp)], ["Por cobrar (mensualidades pendientes, no incluido)", M(r.receivableCents)], [],
    ["POR PERIODO"], ["Periodo", "Ingresos", "Egresos", "Utilidad", "Margen"],
    ...r.periods.map((p) => [p.label, M(p.incomeCents), M(p.expenseCents), M(p.profitCents), formatMargin(p.marginBp)] as Cell[]), [],
    ["INGRESOS POR TIPO"], ...Object.entries(r.income.byKind).map(([k, v]) => [KIND_LABEL[k] ?? k, M(v)] as Cell[]), [],
    ["INGRESOS POR MEDIO DE PAGO"], ["Efectivo", M(r.income.byMethod.cash)], ["Yape/Plin", M(r.income.byMethod.yapePlin)], ["Tarjeta", M(r.income.byMethod.card)], ["Transferencia", M(r.income.byMethod.transfer)], [],
    ["EGRESOS POR CATEGORIA"], ...(Object.keys(CATEGORY_LABEL) as ExpenseCategory[]).map((c) => [CATEGORY_LABEL[c], M(r.expenses.byCategory[c])] as Cell[]), [],
    ["EGRESOS POR ORIGEN DEL PAGO"], ...(Object.keys(SOURCE_LABEL) as ExpenseSource[]).map((s) => [SOURCE_LABEL[s], M(r.expenses.bySource[s])] as Cell[]),
  ];
  return toCsv(rows);
}

export function expensesCsv(list: ExpenseRow[], from: string, to: string): string {
  return toCsv([
    ["Fecha", "Categoria", "Origen del pago", "Descripcion", "Proveedor", "Referencia", "Monto", "Estado"],
    ...list.map((e) => [e.expenseDate, CATEGORY_LABEL[e.category], SOURCE_LABEL[e.source], e.description, e.supplier, e.reference, M(e.amountCents), e.voidedAt ? "ANULADO" : "Vigente"] as Cell[]),
    [], ["Rango", `${from} a ${to}`], ["Total vigente", M(list.filter((e) => !e.voidedAt).reduce((n, e) => n + e.amountCents, 0))],
  ]);
}

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
const num = (s: string, n: number) => (s.length >= n ? s : " ".repeat(n - s.length) + s);
const soles = (c: number) => `${c < 0 ? "-" : ""}S/ ${(Math.abs(c) / 100).toFixed(2)}`;

export function summaryPdf(r: Report, tenantName: string): Buffer {
  const L: PdfLine[] = [
    { text: "REPORTE FINANCIERO", bold: true }, { text: tenantName }, { text: `Periodo: ${r.from} al ${r.to} (${GRANULARITY_LABEL[r.granularity]})` }, { text: "" },
    { text: "RESUMEN", bold: true },
    { text: `${pad("Ingresos cobrados", 34)}${num(soles(r.income.totalCents), 14)}   (${r.income.salesCount} ventas)` },
    { text: `${pad("Descuentos otorgados (incluidos)", 34)}${num(soles(r.income.discountsCents), 14)}` },
    { text: `${pad("Egresos", 34)}${num(soles(r.expenses.totalCents), 14)}   (${r.expenses.count} gastos)` },
    { text: `${pad("UTILIDAD", 34)}${num(soles(r.profitCents), 14)}`, bold: true },
    { text: `${pad("Margen", 34)}${num(formatMargin(r.marginBp), 14)}` },
    { text: `${pad("Por cobrar (no incluido)", 34)}${num(soles(r.receivableCents), 14)}` }, { text: "" },
    { text: `${pad("POR PERIODO", 40)}${num("Ingresos", 12)}${num("Egresos", 12)}${num("Utilidad", 12)}${num("Margen", 9)}`, bold: true },
    ...r.periods.map((p) => ({ text: `${pad(p.label, 40)}${num(soles(p.incomeCents), 12)}${num(soles(p.expenseCents), 12)}${num(soles(p.profitCents), 12)}${num(formatMargin(p.marginBp), 9)}` })), { text: "" },
    { text: "INGRESOS POR TIPO", bold: true }, ...Object.entries(r.income.byKind).map(([k, v]) => ({ text: `${pad(KIND_LABEL[k] ?? k, 34)}${num(soles(v), 14)}` })), { text: "" },
    { text: "INGRESOS POR MEDIO DE PAGO", bold: true },
    { text: `${pad("Efectivo", 34)}${num(soles(r.income.byMethod.cash), 14)}` }, { text: `${pad("Yape/Plin", 34)}${num(soles(r.income.byMethod.yapePlin), 14)}` },
    { text: `${pad("Tarjeta", 34)}${num(soles(r.income.byMethod.card), 14)}` }, { text: `${pad("Transferencia", 34)}${num(soles(r.income.byMethod.transfer), 14)}` }, { text: "" },
    { text: "EGRESOS POR CATEGORIA", bold: true }, ...(Object.keys(CATEGORY_LABEL) as ExpenseCategory[]).map((c) => ({ text: `${pad(CATEGORY_LABEL[c], 34)}${num(soles(r.expenses.byCategory[c]), 14)}` })), { text: "" },
    { text: "EGRESOS POR ORIGEN DEL PAGO", bold: true }, ...(Object.keys(SOURCE_LABEL) as ExpenseSource[]).map((s) => ({ text: `${pad(SOURCE_LABEL[s], 34)}${num(soles(r.expenses.bySource[s]), 14)}` })), { text: "" },
    { text: "Criterio: base caja. Ingresos = ventas cobradas; egresos = gastos vigentes (no anulados); utilidad = ingresos - egresos." },
    { text: "Las mensualidades pendientes no son ingreso hasta cobrarse. Comprobante interno, no es un documento tributario." },
  ];
  void PDF_COLS;
  return renderPdf(`Reporte ${r.from} a ${r.to}`, L);
}

export function expensesPdf(list: ExpenseRow[], from: string, to: string, tenantName: string): Buffer {
  const total = list.filter((e) => !e.voidedAt).reduce((n, e) => n + e.amountCents, 0);
  const L: PdfLine[] = [
    { text: "DETALLE DE GASTOS", bold: true }, { text: tenantName }, { text: `Periodo: ${from} al ${to}` }, { text: "" },
    { text: `${pad("Fecha", 11)}${pad("Categoria", 22)}${pad("Descripcion", 38)}${num("Monto", 12)}`, bold: true },
    ...list.map((e) => ({ text: `${pad(e.expenseDate, 11)}${pad(CATEGORY_LABEL[e.category], 22)}${pad((e.voidedAt ? "[ANULADO] " : "") + e.description, 38)}${num(soles(e.amountCents), 12)}` })), { text: "" },
    { text: `${pad("TOTAL VIGENTE", 71)}${num(soles(total), 12)}`, bold: true },
  ];
  return renderPdf(`Gastos ${from} a ${to}`, L);
}
