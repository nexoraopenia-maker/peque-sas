import type { Customer, CreditReason, DocItem, DocKind } from "./pure";

/** Datos de un comprobante listos para enviar al PSE (importes en céntimos; los precios ya incluyen IGV). */
export type AdapterDoc = {
  kind: DocKind; serie: string; number: number; issueDate: string; igvBp: number;
  emisor: { ruc: string; razonSocial: string };
  customer: Customer; items: DocItem[]; taxableCents: number; igvCents: number; totalCents: number;
  credit?: { reason: CreditReason; reasonText: string; refKind: "BOLETA" | "FACTURA"; refSerie: string; refNumber: number };
};

export type DocRef = { kind: DocKind; serie: string; number: number };

/** PENDING = el PSE lo recibió pero SUNAT aún no respondió (se consulta más tarde). */
export type AdapterResult = {
  status: "ACCEPTED" | "REJECTED" | "PENDING";
  code: string | null; description: string | null;
  hash: string | null; qr: string | null;
  pdfUrl: string | null; xmlUrl: string | null; cdrUrl: string | null;
  xml?: string | null; pdf?: Uint8Array | null;
};

/** Fallo de transporte/servicio (red, timeout, 5xx, credenciales): el comprobante NO se descarta, se reintenta. */
export class SunatTransportError extends Error {
  constructor(message: string, readonly retryable = true) { super(message); this.name = "SunatTransportError"; }
}

export interface SunatAdapter {
  readonly provider: "MOCK" | "NUBEFACT";
  /** Emite el comprobante. Debe ser idempotente por serie+número: si ya existe, devuelve su estado. */
  issue(doc: AdapterDoc): Promise<AdapterResult>;
  /** Consulta un comprobante ya enviado (recupera el caso "se envió pero no recibimos la respuesta"). null = no existe. */
  consult(ref: DocRef): Promise<AdapterResult | null>;
  /** Verifica alcance y credenciales (no emite nada). */
  testConnection(): Promise<{ ok: boolean; error?: string }>;
}
