import { SunatTransportError, type AdapterDoc, type AdapterResult, type DocRef, type SunatAdapter } from "./adapter";

/**
 * Adaptador de Nubefact (PSE/OSE). Implementado según el contrato JSON de Nubefact (operaciones `generar_comprobante` y
 * `consultar_comprobante`, token en la cabecera Authorization). ESTADO: implementado y probado contra un servidor HTTP local que
 * reproduce ese contrato; NO verificado contra un Nubefact real (requiere cuenta/ruta/token del establecimiento): ver docs/SUNAT_FACTURACION.md.
 *
 * Clasificación de respuestas:
 *  - HTTP 401/403/5xx, red o timeout -> SunatTransportError (se reintenta).
 *  - Error de validación de Nubefact (4xx con `errors`) -> REJECTED (corregir datos); excepción: código 23 "ya existe" -> se consulta.
 *  - `aceptada_por_sunat` true -> ACCEPTED; false con `sunat_soap_error` (SUNAT caído) -> PENDING; false con código de SUNAT -> REJECTED.
 */
const TYPE = { FACTURA: 1, BOLETA: 2, CREDIT_NOTE: 3 } as const;
const c2 = (c: number) => Number((c / 100).toFixed(2));
const dmy = (iso: string) => iso.split("-").reverse().join("-");
const dec = (n: number) => Number(n.toFixed(10));

export class NubefactAdapter implements SunatAdapter {
  readonly provider = "NUBEFACT" as const;
  constructor(private cfg: { apiUrl: string; token: string; timeoutMs?: number; fetchImpl?: typeof fetch }) {}

  private async call(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, any> }> {
    const f = this.cfg.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await f(this.cfg.apiUrl, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 20_000),
        headers: { "Content-Type": "application/json", Authorization: `Token token="${this.cfg.token}"` },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new SunatTransportError(`No se pudo contactar al PSE: ${e instanceof Error ? e.message : "error de red"}`);
    }
    if (res.status === 401 || res.status === 403) throw new SunatTransportError("El PSE rechazó las credenciales (token o ruta inválidos)");
    if (res.status >= 500) throw new SunatTransportError(`El PSE respondió con error ${res.status}`);
    let json: Record<string, any>;
    try { json = (await res.json()) as Record<string, any>; } catch { throw new SunatTransportError(`Respuesta no válida del PSE (HTTP ${res.status})`); }
    return { status: res.status, json };
  }

  private map(j: Record<string, any>): AdapterResult {
    const str = (v: unknown) => (typeof v === "string" && v ? v : null);
    const base = { hash: str(j.codigo_hash), qr: str(j.cadena_para_codigo_qr), pdfUrl: str(j.enlace_del_pdf), xmlUrl: str(j.enlace_del_xml), cdrUrl: str(j.enlace_del_cdr) };
    const code = j.sunat_responsecode != null && j.sunat_responsecode !== "" ? String(j.sunat_responsecode) : null;
    const description = str(j.sunat_description) ?? str(j.sunat_note);
    if (j.aceptada_por_sunat === true) return { status: "ACCEPTED", code: code ?? "0", description, ...base };
    if (str(j.sunat_soap_error)) return { status: "PENDING", code, description: String(j.sunat_soap_error).slice(0, 300), ...base };
    if (code && code !== "0") return { status: "REJECTED", code, description, ...base };
    return { status: "PENDING", code, description, ...base }; // enviado, SUNAT aún no responde
  }

  async issue(d: AdapterDoc): Promise<AdapterResult> {
    const body: Record<string, unknown> = {
      operacion: "generar_comprobante", tipo_de_comprobante: TYPE[d.kind], serie: d.serie, numero: d.number, sunat_transaction: 1,
      cliente_tipo_de_documento: d.customer.docType === "RUC" ? 6 : d.customer.docType === "DNI" ? 1 : "-",
      cliente_numero_de_documento: d.customer.docNumber ?? "-", cliente_denominacion: d.customer.name,
      cliente_direccion: d.customer.address ?? "", cliente_email: d.customer.email ?? "",
      fecha_de_emision: dmy(d.issueDate), moneda: 1, porcentaje_de_igv: d.igvBp / 100,
      total_gravada: c2(d.taxableCents), total_igv: c2(d.igvCents), total: c2(d.totalCents),
      detraccion: false, enviar_automaticamente_a_la_sunat: true, enviar_automaticamente_al_cliente: Boolean(d.customer.email),
      items: d.items.map((i) => {
        const unitIncl = i.totalCents / i.quantity / 100, unitBase = i.taxableCents / i.quantity / 100;
        return {
          unidad_de_medida: i.unit, descripcion: i.description, cantidad: i.quantity, valor_unitario: dec(unitBase), precio_unitario: dec(unitIncl),
          subtotal: c2(i.taxableCents), tipo_de_igv: d.igvBp > 0 ? 1 : 8, igv: c2(i.igvCents), total: c2(i.totalCents), anticipo_regularizacion: false,
        };
      }),
    };
    if (d.credit) {
      body.tipo_de_nota_de_credito = Number(d.credit.reason);
      body.documento_que_se_modifica_tipo = TYPE[d.credit.refKind];
      body.documento_que_se_modifica_serie = d.credit.refSerie;
      body.documento_que_se_modifica_numero = d.credit.refNumber;
      body.observaciones = d.credit.reasonText;
    }
    const { status, json } = await this.call(body);
    if (json.errors || status >= 400) {
      if (String(json.codigo) === "23") { // ya existe en Nubefact: recuperar su estado
        const prev = await this.consult({ kind: d.kind, serie: d.serie, number: d.number });
        if (prev) return prev;
      }
      return { status: "REJECTED", code: `NF-${json.codigo ?? status}`, description: String(json.errors ?? "Error de validación del PSE").slice(0, 300), hash: null, qr: null, pdfUrl: null, xmlUrl: null, cdrUrl: null };
    }
    return this.map(json);
  }

  async consult(ref: DocRef): Promise<AdapterResult | null> {
    const { status, json } = await this.call({ operacion: "consultar_comprobante", tipo_de_comprobante: TYPE[ref.kind], serie: ref.serie, numero: ref.number });
    if (json.errors || status >= 400) {
      if (String(json.codigo) === "20" || /no existe|no encontrad/i.test(String(json.errors ?? ""))) return null;
      throw new SunatTransportError(`Consulta rechazada por el PSE: ${String(json.errors ?? status).slice(0, 200)}`);
    }
    return this.map(json);
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try { await this.consult({ kind: "FACTURA", serie: "F001", number: 1 }); return { ok: true }; }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : "error" }; }
  }
}
