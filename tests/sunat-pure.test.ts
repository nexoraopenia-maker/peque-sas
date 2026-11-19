import { createServer, type IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
  BOLETA_DNI_THRESHOLD_CENTS, MAX_ATTEMPTS, buildDocItems, docNumber, isAllowedFileUrl, isValidDni, isValidRuc, nextAttemptAt, normalizeCustomer, splitIgv, validateApiUrl, validateSeries,
} from "@/lib/sunat/pure";
import { NubefactAdapter } from "@/lib/sunat/nubefact";
import { MOCK_DOWN, MOCK_REJECT, MockSunatAdapter } from "@/lib/sunat/mock";
import { SunatTransportError, type AdapterDoc } from "@/lib/sunat/adapter";

const RUC = "20131312955";
const doc = (over: Partial<AdapterDoc> = {}): AdapterDoc => ({
  kind: "BOLETA", serie: "B001", number: 7, issueDate: "2026-11-18", igvBp: 1800, emisor: { ruc: RUC, razonSocial: "PEQUES SAC" },
  customer: { docType: "NONE", docNumber: null, name: "CLIENTE VARIOS", address: null, email: null },
  items: [{ description: "Servicio de ludoteca", quantity: 1, unit: "ZZ", totalCents: 11800, taxableCents: 10000, igvCents: 1800 }], taxableCents: 10000, igvCents: 1800, totalCents: 11800, ...over,
});

describe("RUC y DNI", () => {
  it("valida dígito verificador y prefijo", () => {
    expect(isValidRuc(RUC)).toBe(true);
    expect(isValidRuc("20131312954")).toBe(false);   // dígito verificador
    expect(isValidRuc("30131312955")).toBe(false);   // prefijo
    expect(isValidRuc("2013131295")).toBe(false);    // longitud
    expect(isValidRuc("2013131295a")).toBe(false);
    expect(isValidDni("12345678")).toBe(true);
    expect(isValidDni("1234567")).toBe(false);
    expect(isValidDni("1234567a")).toBe(false);
  });
});

describe("comprador", () => {
  it("la factura exige RUC válido, razón social y dirección", () => {
    expect(normalizeCustomer("FACTURA", 5000, { docType: "RUC", docNumber: "20131312954", name: "ACME SAC", address: "Av. Lima 123" })).toMatchObject({ ok: false });
    expect(normalizeCustomer("FACTURA", 5000, { docNumber: RUC, name: "AC", address: "Av. Lima 123" })).toMatchObject({ ok: false });
    expect(normalizeCustomer("FACTURA", 5000, { docNumber: RUC, name: "ACME SAC", address: "x" })).toMatchObject({ ok: false });
    expect(normalizeCustomer("FACTURA", 5000, { docNumber: RUC, name: "ACME SAC", address: "Av. Lima 123" })).toMatchObject({ ok: true, value: { docType: "RUC" } });
  });
  it("la boleta sin documento es CLIENTE VARIOS salvo desde S/ 700", () => {
    expect(normalizeCustomer("BOLETA", 69_999, {})).toMatchObject({ ok: true, value: { docType: "NONE", name: "CLIENTE VARIOS" } });
    expect(normalizeCustomer("BOLETA", BOLETA_DNI_THRESHOLD_CENTS, {})).toMatchObject({ ok: false });
    expect(normalizeCustomer("BOLETA", BOLETA_DNI_THRESHOLD_CENTS, { docNumber: "12345678", name: "Ana Pérez" })).toMatchObject({ ok: true, value: { docType: "DNI" } });
    expect(normalizeCustomer("BOLETA", 1000, { docNumber: "123", name: "Ana" })).toMatchObject({ ok: false });
    expect(normalizeCustomer("BOLETA", 1000, { docNumber: "12345678", name: "" })).toMatchObject({ ok: false });
  });
  it("limpia caracteres de control y rechaza correos inválidos", () => {
    const r = normalizeCustomer("BOLETA", 1000, { docNumber: "12345678", name: "Ana\n\tPérez  ", email: "a@b.pe" });
    expect(r).toMatchObject({ ok: true, value: { name: "Ana Pérez", email: "a@b.pe" } });
    expect(normalizeCustomer("BOLETA", 1000, { email: "no-es-correo" })).toMatchObject({ ok: false });
  });
});

describe("IGV e ítems", () => {
  it("separa base e IGV sin perder céntimos", () => {
    expect(splitIgv(11800, 1800)).toEqual({ taxableCents: 10000, igvCents: 1800 });
    for (const t of [1, 99, 1000, 12345, 99999]) { const s = splitIgv(t, 1800); expect(s.taxableCents + s.igvCents).toBe(t); }
    expect(splitIgv(5000, 0)).toEqual({ taxableCents: 5000, igvCents: 0 });
  });
  it("itemiza ventas sin descuentos y totaliza exacto", () => {
    const r = buildDocItems("POS", [{ kind: "PRODUCT", description: "Jugo", quantity: 2, totalCents: 1000 }, { kind: "PRODUCT", description: "Galleta", quantity: 1, totalCents: 333 }], 1333, 1800);
    expect(r.items).toHaveLength(2);
    expect(r.items.every((i) => i.unit === "NIU")).toBe(true);
    expect(r.taxableCents + r.igvCents).toBe(1333);
    expect(r.totalCents).toBe(1333);
  });
  it("con descuentos o saldo aplicado emite una sola línea por el neto", () => {
    const r = buildDocItems("PLAYGROUND", [
      { kind: "BASE_RATE", description: "Tarifa 60 min", quantity: 1, totalCents: 3000 },
      { kind: "PREPAID_CREDIT", description: "Cuponera", quantity: 20, totalCents: -1000 },
      { kind: "COUPON_DISCOUNT", description: "Cupón", quantity: 1, totalCents: -500 },
    ], 1500, 1800);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ description: "Servicio de ludoteca", totalCents: 1500, unit: "ZZ" });
    expect(r.totalCents).toBe(1500);
  });
  it("rechaza ventas sin importe o con ítems que no suman", () => {
    expect(() => buildDocItems("POS", [], 0, 1800)).toThrow();
    expect(() => buildDocItems("POS", [{ kind: "PRODUCT", description: "x", quantity: 1, totalCents: 100 }], 200, 1800)).toThrow(/no suman/);
  });
});

describe("series, URLs y reintentos", () => {
  it("valida series", () => {
    const ok = { serieBoleta: "B001", serieFactura: "F001", serieNcBoleta: "BC01", serieNcFactura: "FC01" };
    expect(validateSeries(ok)).toBeNull();
    expect(validateSeries({ ...ok, serieBoleta: "F001" })).toMatch(/B/);
    expect(validateSeries({ ...ok, serieNcFactura: "F001" })).toMatch(/distintas/);
    expect(validateSeries({ ...ok, serieBoleta: "B01" })).not.toBeNull();
    expect(docNumber("B001", 42)).toBe("B001-00000042");
  });
  it("la URL del PSE solo admite nubefact.com por https (anti-SSRF)", () => {
    const prod = (u: string) => validateApiUrl(u, false);
    expect(prod("https://api.nubefact.com/api/v1/abc")).toBeNull();
    expect(prod("http://api.nubefact.com/api/v1/abc")).toMatch(/https/);
    expect(prod("https://evil.com/nubefact.com")).toMatch(/nubefact/);
    expect(prod("https://nubefact.com.evil.com/x")).toMatch(/nubefact/);
    expect(prod("https://169.254.169.254/latest")).toMatch(/nubefact/);
    expect(prod("https://user:pw@api.nubefact.com/x")).toMatch(/credenciales/);
    expect(prod("http://127.0.0.1:3000/x")).not.toBeNull();
    expect(validateApiUrl("http://127.0.0.1:3000/x", true)).toBeNull();
    expect(prod("no es url")).toMatch(/inválida/);
  });
  it("las descargas solo van a hosts permitidos", () => {
    const api = "https://api.nubefact.com/api/v1/abc";
    expect(isAllowedFileUrl("https://www.nubefact.com/cpe/x.pdf", api, false)).toBe(true);
    expect(isAllowedFileUrl("https://evil.com/x.pdf", api, false)).toBe(false);
    expect(isAllowedFileUrl("http://www.nubefact.com/x.pdf", api, false)).toBe(false);
    expect(isAllowedFileUrl("https://169.254.169.254/", api, false)).toBe(false);
  });
  it("espera creciente y tope de intentos", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const mins = [1, 2, 3, 4, 5, 6, 7].map((a) => (nextAttemptAt(a, t0)!.getTime() - t0.getTime()) / 60_000);
    expect(mins).toEqual([1, 5, 15, 60, 180, 360, 720]);
    expect(nextAttemptAt(MAX_ATTEMPTS, t0)).toBeNull();
  });
});

describe("adaptador simulado", () => {
  it("acepta, marca el XML/PDF como simulados y rechaza por disparador", async () => {
    const m = new MockSunatAdapter();
    const r = await m.issue(doc());
    expect(r.status).toBe("ACCEPTED");
    expect(r.xml).toContain("SIMULADO");
    expect(Buffer.from(r.pdf!).subarray(0, 5).toString()).toBe("%PDF-");
    expect((await m.issue(doc({ customer: { docType: "DNI", docNumber: "12345678", name: `Ana ${MOCK_REJECT}`, address: null, email: null } }))).status).toBe("REJECTED");
    await expect(m.issue(doc({ customer: { docType: "DNI", docNumber: "12345678", name: `Ana ${MOCK_DOWN}`, address: null, email: null } }))).rejects.toBeInstanceOf(SunatTransportError);
    expect(await m.consult({ kind: "BOLETA", serie: "B001", number: 1 })).toBeNull();
  });
});

describe("adaptador Nubefact (contra un servidor HTTP local que reproduce el contrato; NO es Nubefact real)", () => {
  const serve = async (handler: (body: Record<string, any>, req: IncomingMessage) => { status: number; json?: unknown; raw?: string }) => {
    const calls: { body: Record<string, any>; auth: string | undefined }[] = [];
    const srv = createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
        const body = JSON.parse(b); calls.push({ body, auth: req.headers.authorization });
        const r = handler(body, req); res.writeHead(r.status, { "Content-Type": "application/json" }); res.end(r.raw ?? JSON.stringify(r.json ?? {}));
      });
    });
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
    const port = (srv.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}/api/v1/x`, calls, close: () => new Promise<void>((ok) => srv.close(() => ok())) };
  };

  it("arma el JSON de una boleta y mapea una respuesta aceptada", async () => {
    const s = await serve(() => ({ status: 200, json: { aceptada_por_sunat: true, sunat_responsecode: "0", sunat_description: "La Boleta ha sido aceptada", codigo_hash: "HASH", cadena_para_codigo_qr: "QR", enlace_del_pdf: "https://www.nubefact.com/cpe/a.pdf", enlace_del_xml: "https://www.nubefact.com/cpe/a.xml", enlace_del_cdr: "https://www.nubefact.com/cpe/a.cdr" } }));
    try {
      const r = await new NubefactAdapter({ apiUrl: s.url, token: "TOKEN-SECRETO" }).issue(doc());
      expect(r).toMatchObject({ status: "ACCEPTED", code: "0", hash: "HASH", qr: "QR", pdfUrl: "https://www.nubefact.com/cpe/a.pdf", xmlUrl: "https://www.nubefact.com/cpe/a.xml" });
      const c = s.calls[0]!;
      expect(c.auth).toBe('Token token="TOKEN-SECRETO"');
      expect(c.body).toMatchObject({
        operacion: "generar_comprobante", tipo_de_comprobante: 2, serie: "B001", numero: 7, fecha_de_emision: "18-11-2026", moneda: 1, porcentaje_de_igv: 18,
        cliente_tipo_de_documento: "-", cliente_denominacion: "CLIENTE VARIOS", total_gravada: 100, total_igv: 18, total: 118, enviar_automaticamente_a_la_sunat: true,
      });
      expect(c.body.items[0]).toMatchObject({ unidad_de_medida: "ZZ", cantidad: 1, valor_unitario: 100, precio_unitario: 118, subtotal: 100, igv: 18, total: 118, tipo_de_igv: 1 });
    } finally { await s.close(); }
  });

  it("factura y nota de crédito llevan tipo, receptor y documento que modifica", async () => {
    const s = await serve(() => ({ status: 200, json: { aceptada_por_sunat: true, sunat_responsecode: "0" } }));
    try {
      const a = new NubefactAdapter({ apiUrl: s.url, token: "t0k3n-1234" });
      await a.issue(doc({ kind: "FACTURA", serie: "F001", customer: { docType: "RUC", docNumber: RUC, name: "ACME SAC", address: "Av. Lima 1", email: "a@b.pe" } }));
      await a.issue(doc({ kind: "CREDIT_NOTE", serie: "FC01", number: 1, customer: { docType: "RUC", docNumber: RUC, name: "ACME SAC", address: "Av. Lima 1", email: null }, credit: { reason: "01", reasonText: "Anulación", refKind: "FACTURA", refSerie: "F001", refNumber: 3 } }));
      expect(s.calls[0]!.body).toMatchObject({ tipo_de_comprobante: 1, cliente_tipo_de_documento: 6, cliente_numero_de_documento: RUC, cliente_email: "a@b.pe", enviar_automaticamente_al_cliente: true });
      expect(s.calls[1]!.body).toMatchObject({ tipo_de_comprobante: 3, tipo_de_nota_de_credito: 1, documento_que_se_modifica_tipo: 1, documento_que_se_modifica_serie: "F001", documento_que_se_modifica_numero: 3 });
    } finally { await s.close(); }
  });

  it("clasifica respuestas: SUNAT caído = pendiente, rechazo SUNAT, error de validación, credenciales y 5xx = reintento", async () => {
    let mode = 0;
    const s = await serve(() => [
      { status: 200, json: { aceptada_por_sunat: false, sunat_soap_error: "SUNAT no disponible" } },
      { status: 200, json: { aceptada_por_sunat: false, sunat_responsecode: "2800", sunat_description: "RUC inválido" } },
      { status: 400, json: { errors: "Serie no registrada", codigo: 10 } },
      { status: 401, json: { errors: "token" } },
      { status: 503, json: {} },
      { status: 200, raw: "<html>no json</html>" },
    ][mode++]!);
    try {
      const a = new NubefactAdapter({ apiUrl: s.url, token: "t0k3n-1234" });
      expect(await a.issue(doc())).toMatchObject({ status: "PENDING", description: "SUNAT no disponible" });
      expect(await a.issue(doc())).toMatchObject({ status: "REJECTED", code: "2800" });
      expect(await a.issue(doc())).toMatchObject({ status: "REJECTED", code: "NF-10", description: "Serie no registrada" });
      await expect(a.issue(doc())).rejects.toBeInstanceOf(SunatTransportError);
      await expect(a.issue(doc())).rejects.toBeInstanceOf(SunatTransportError);
      await expect(a.issue(doc())).rejects.toBeInstanceOf(SunatTransportError);
    } finally { await s.close(); }
  });

  it("si el documento ya existe (código 23) consulta y devuelve su estado", async () => {
    const s = await serve((b) => b.operacion === "generar_comprobante"
      ? { status: 400, json: { errors: "Este documento ya existe en NubeFacT", codigo: 23 } }
      : { status: 200, json: { aceptada_por_sunat: true, sunat_responsecode: "0", codigo_hash: "H" } });
    try {
      const r = await new NubefactAdapter({ apiUrl: s.url, token: "t0k3n-1234" }).issue(doc());
      expect(r).toMatchObject({ status: "ACCEPTED", hash: "H" });
      expect(s.calls.map((c) => c.body.operacion)).toEqual(["generar_comprobante", "consultar_comprobante"]);
    } finally { await s.close(); }
  });

  it("un servidor inaccesible es un fallo de transporte y no revela el token", async () => {
    const a = new NubefactAdapter({ apiUrl: "http://127.0.0.1:1/x", token: "TOKEN-SECRETO", timeoutMs: 2000 });
    const e = await a.issue(doc()).catch((x) => x);
    expect(e).toBeInstanceOf(SunatTransportError);
    expect(String(e.message)).not.toContain("TOKEN-SECRETO");
    expect((await a.testConnection()).ok).toBe(false);
  });
});
