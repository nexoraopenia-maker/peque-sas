import { createHash } from "node:crypto";
import { renderPdf } from "@/lib/reports/pdf";
import { SunatTransportError, type AdapterDoc, type AdapterResult, type DocRef, type SunatAdapter } from "./adapter";
import { KIND_NAME, docNumber, isValidDni, isValidRuc } from "./pure";

/** Disparadores de prueba (solo en el adaptador simulado): se escriben en el nombre del comprador. */
export const MOCK_REJECT = "[MOCK-RECHAZAR]";
export const MOCK_DOWN = "[MOCK-CAIDO]";
const money = (c: number) => (c / 100).toFixed(2);
const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

/**
 * Adaptador SIMULADO (sandbox). No contacta a SUNAT ni a ningún PSE: acepta comprobantes válidos y genera un XML y un PDF marcados
 * como "SIMULADO – SIN VALIDEZ TRIBUTARIA". Sirve para pruebas, demos y para ensayar el flujo completo sin credenciales.
 */
export class MockSunatAdapter implements SunatAdapter {
  readonly provider = "MOCK" as const;
  async issue(d: AdapterDoc): Promise<AdapterResult> {
    if (d.customer.name.includes(MOCK_DOWN)) throw new SunatTransportError("Simulación: el PSE no responde");
    const label = `${KIND_NAME[d.kind]} ${docNumber(d.serie, d.number)}`;
    if (d.customer.name.includes(MOCK_REJECT)) return { status: "REJECTED", code: "2800", description: `Simulación: SUNAT rechazó ${label}`, hash: null, qr: null, pdfUrl: null, xmlUrl: null, cdrUrl: null };
    if (d.customer.docType === "RUC" && !isValidRuc(d.customer.docNumber ?? "")) return { status: "REJECTED", code: "2800", description: "RUC del receptor inválido", hash: null, qr: null, pdfUrl: null, xmlUrl: null, cdrUrl: null };
    if (d.customer.docType === "DNI" && !isValidDni(d.customer.docNumber ?? "")) return { status: "REJECTED", code: "2800", description: "DNI del receptor inválido", hash: null, qr: null, pdfUrl: null, xmlUrl: null, cdrUrl: null };
    const xml = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<!-- SIMULADO - SIN VALIDEZ TRIBUTARIA: no fue enviado a SUNAT -->`,
      `<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" simulated="true">`,
      `  <UBLVersionID>2.1</UBLVersionID><CustomizationID>2.0</CustomizationID>`,
      `  <ID>${esc(docNumber(d.serie, d.number))}</ID><IssueDate>${d.issueDate}</IssueDate><DocumentCurrencyCode>PEN</DocumentCurrencyCode>`,
      `  <Supplier><RUC>${esc(d.emisor.ruc)}</RUC><Name>${esc(d.emisor.razonSocial)}</Name></Supplier>`,
      `  <Customer><DocType>${d.customer.docType}</DocType><DocNumber>${esc(d.customer.docNumber ?? "-")}</DocNumber><Name>${esc(d.customer.name)}</Name></Customer>`,
      ...(d.credit ? [`  <BillingReference>${esc(docNumber(d.credit.refSerie, d.credit.refNumber))}</BillingReference><ResponseCode>${d.credit.reason}</ResponseCode>`] : []),
      ...d.items.map((i) => `  <Line><Description>${esc(i.description)}</Description><Quantity>${i.quantity}</Quantity><Total>${money(i.totalCents)}</Total></Line>`),
      `  <TaxTotal>${money(d.igvCents)}</TaxTotal><Taxable>${money(d.taxableCents)}</Taxable><Payable>${money(d.totalCents)}</Payable>`,
      `</Invoice>`,
    ].join("\n");
    const pdfText = [
      "*** SIMULADO - SIN VALIDEZ TRIBUTARIA ***", "", `${d.emisor.razonSocial}  RUC ${d.emisor.ruc}`, `${label}`, `Fecha: ${d.issueDate}`,
      `Cliente: ${d.customer.name} (${d.customer.docType} ${d.customer.docNumber ?? "-"})`, "",
      ...d.items.map((i) => `${i.quantity} x ${i.description}  S/ ${money(i.totalCents)}`), "",
      `Op. gravada S/ ${money(d.taxableCents)}   IGV S/ ${money(d.igvCents)}   TOTAL S/ ${money(d.totalCents)}`,
      ...(d.credit ? ["", `Modifica: ${docNumber(d.credit.refSerie, d.credit.refNumber)}  Motivo: ${d.credit.reasonText}`] : []),
    ];
    const pdf = renderPdf(label, pdfText.map((text, i) => ({ text, bold: i === 0 })));
    const hash = createHash("sha256").update(xml).digest("base64");
    return {
      status: "ACCEPTED", code: "0", description: `Simulación: ${label} aceptada (sin validez tributaria)`, hash,
      qr: `${d.emisor.ruc}|${d.serie}|${d.number}|${money(d.igvCents)}|${money(d.totalCents)}|${d.issueDate}|SIMULADO`,
      pdfUrl: null, xmlUrl: null, cdrUrl: null, xml, pdf: new Uint8Array(pdf),
    };
  }
  async consult(_ref: DocRef): Promise<AdapterResult | null> { return null; } // sin estado: reenviar es idempotente
  async testConnection() { return { ok: true }; }
}
