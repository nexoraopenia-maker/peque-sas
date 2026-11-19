import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { openCashSession, posSale } from "@/lib/billing/service";
import { createExpense, getCashierLimit, setCashierLimit } from "@/lib/expenses/service";
import { adapterFor, getSunatConfig, saveSunatConfig, setSunatEnabled, testSunatConfig, type SaveSunatConfig } from "@/lib/sunat/config";
import { createCreditNote, createDocumentForSale, fetchArtifacts, issueAfterSale, processDue, retryDocument, sendDocument } from "@/lib/sunat/service";
import { SunatTransportError, type AdapterDoc, type AdapterResult, type SunatAdapter } from "@/lib/sunat/adapter";
import { MOCK_REJECT, MockSunatAdapter } from "@/lib/sunat/mock";
import { decryptSecret } from "@/lib/whatsapp/crypto";

// Contra Turso remoto (RUN_REMOTE_TESTS=1) usando el adaptador SIMULADO (no se contacta a ningún PSE real).
const run = process.env.RUN_REMOTE_TESTS === "1" ? describe : describe.skip;
const tag = `__sunat_${Date.now()}`;
const RUC = "20131312955";
let planId = "", A = "", B = "", uA = "", uB = "", seq = 0;
const key = () => `${tag}-${++seq}-${Math.random().toString(36).slice(2)}`;
const cfgOf = (t: string, u: string, over: Partial<SaveSunatConfig> = {}): SaveSunatConfig => ({
  tenantId: t, userId: u, provider: "MOCK", rucEmisor: RUC, razonSocial: "PEQUES DE PRUEBA SAC", serieBoleta: "B001", serieFactura: "F001", serieNcBoleta: "BC01", serieNcFactura: "FC01", igvBp: 1800, autoIssue: false, ...over,
});
const product = (tenantId: string, priceCents: number) => db.product.create({ data: { tenantId, name: `P${++seq}`, stock: 1000, priceCents } });
const sell = async (tenantId: string, userId: string, priceCents = 11800, method: "EFECTIVO" | "TARJETA" = "TARJETA") => {
  const p = await product(tenantId, priceCents);
  return (await posSale({ tenantId, userId, lines: [{ productId: p.id, quantity: 1 }], pay: { first: method, firstAmountCents: null }, idempotencyKey: key() })).saleId;
};
const emit = (t: string, u: string, saleId: string, over: Record<string, unknown> = {}) => createDocumentForSale({ tenantId: t, userId: u, saleId, kind: "BOLETA", customer: {}, ...over } as never);
const getDoc = (id: string) => db.sunatDocument.findFirstOrThrow({ where: { id } });
const wipe = async (ids: string[]) => {
  const w = { where: { tenantId: { in: ids } } };
  for (const m of ["sunatDocument", "sunatSeries", "sunatConfig", "expense", "saleItem", "sale", "stockMovement", "product", "cashRegisterSession", "auditLog", "user"] as const) await (db[m] as unknown as { deleteMany: (a: object) => Promise<unknown> }).deleteMany(w);
};
/** Adaptador que falla/acepta según un guion, para probar reintentos sin red. */
class Scripted implements SunatAdapter {
  readonly provider = "MOCK" as const;
  issued = 0; consulted = 0;
  constructor(private issueFn: (d: AdapterDoc, n: number) => Promise<AdapterResult> | AdapterResult, private consultFn: () => AdapterResult | null = () => null) {}
  issue(d: AdapterDoc) { return Promise.resolve(this.issueFn(d, ++this.issued)); }
  async consult() { this.consulted++; return this.consultFn(); }
  async testConnection() { return { ok: true }; }
}
const down = () => new Scripted(() => { throw new SunatTransportError("PSE caído (simulado)"); });

run("Fase 15: facturación electrónica (Turso remoto, adaptador simulado)", () => {
  beforeAll(async () => {
    planId = (await db.plan.create({ data: { name: tag, modules: [] } })).id;
    A = (await db.tenant.create({ data: { name: `${tag}-A`, businessType: "t", planId, modules: ["SUNAT"] } })).id;
    B = (await db.tenant.create({ data: { name: `${tag}-B`, businessType: "t", planId, modules: ["SUNAT"] } })).id;
    uA = (await db.user.create({ data: { email: `${tag}-a@example.test`, name: "a", role: "ADMIN", tenantId: A, passwordHash: "x" } })).id;
    uB = (await db.user.create({ data: { email: `${tag}-b@example.test`, name: "b", role: "ADMIN", tenantId: B, passwordHash: "x" } })).id;
    await openCashSession(A, uA, 0); await openCashSession(B, uB, 0);
  }, 120000);
  afterAll(async () => { await wipe([A, B]); await db.tenant.deleteMany({ where: { id: { in: [A, B] } } }); await db.plan.deleteMany({ where: { id: planId } }); }, 120000);

  it("configuración: valida datos, cifra el token y exige probar antes de activar", async () => {
    await expect(saveSunatConfig(cfgOf(A, uA, { rucEmisor: "20131312954" }))).rejects.toThrow(/RUC/);
    await expect(saveSunatConfig(cfgOf(A, uA, { serieBoleta: "F001" }))).rejects.toThrow(/boleta/);
    await expect(saveSunatConfig(cfgOf(A, uA, { provider: "NUBEFACT", sunatApiUrl: "https://evil.example.com/x", sunatToken: "tok-12345678" }))).rejects.toThrow(/nubefact/i);
    await expect(saveSunatConfig(cfgOf(A, uA, { provider: "NUBEFACT", sunatApiUrl: "https://api.nubefact.com/api/v1/abc" }))).rejects.toThrow(/token/i);
    await saveSunatConfig(cfgOf(A, uA, { provider: "NUBEFACT", sunatApiUrl: "https://api.nubefact.com/api/v1/abc", sunatToken: "TOKEN-SECRETO-123" }));
    const c = (await getSunatConfig(A))!;
    expect(c.sunatTokenEnc).not.toContain("TOKEN-SECRETO");
    expect(c.sunatTokenLast4).toBe("-123");
    expect(decryptSecret(c.sunatTokenEnc!, A, "sunatToken")).toBe("TOKEN-SECRETO-123");
    expect(() => decryptSecret(c.sunatTokenEnc!, B, "sunatToken")).toThrow();        // ligado al tenant
    expect(() => decryptSecret(c.sunatTokenEnc!, A, "otroCampo")).toThrow();         // ligado al campo
    expect(adapterFor(c).provider).toBe("NUBEFACT");
    await expect(setSunatEnabled(A, true)).rejects.toThrow(/Prueba la conexión/);
    // volver al modo simulado: se prueba y se activa; cambiar de proveedor invalida la prueba
    await saveSunatConfig(cfgOf(A, uA));
    expect((await getSunatConfig(A))!).toMatchObject({ provider: "MOCK", enabled: false, lastTestOk: null, sunatTokenEnc: null });
    expect((await testSunatConfig(A)).ok).toBe(true);
    await setSunatEnabled(A, true);
    expect((await getSunatConfig(A))!.enabled).toBe(true);
    await saveSunatConfig(cfgOf(A, uA, { razonSocial: "PEQUES DE PRUEBA SAC" }));     // mismos datos de conexión: sigue activa
    expect((await getSunatConfig(A))!.enabled).toBe(true);
    await saveSunatConfig(cfgOf(B, uB)); await testSunatConfig(B); await setSunatEnabled(B, true);
  }, 240000);

  it("boleta desde un cobro: numera, envía, guarda XML/PDF y es idempotente", async () => {
    const saleId = await sell(A, uA);
    const r = await emit(A, uA, saleId);
    expect(r.duplicate).toBe(false);
    const pending = await getDoc(r.id);
    expect([pending.status, pending.serie, pending.number, pending.customerName, pending.totalCents, pending.taxableCents, pending.igvCents]).toEqual(["PENDING", "B001", 1, "CLIENTE VARIOS", 11800, 10000, 1800]);
    expect(await sendDocument(A, r.id)).toBe("ACCEPTED");
    const d = await getDoc(r.id);
    expect(d.status).toBe("ACCEPTED"); expect(d.acceptedAt).not.toBeNull(); expect(d.attempts).toBe(1);
    expect(d.xml).toContain("SIMULADO"); expect(Buffer.from(d.pdf!).subarray(0, 5).toString()).toBe("%PDF-");
    expect(d.responseCode).toBe("0"); expect(d.hash).toBeTruthy();
    expect((await emit(A, uA, saleId))).toEqual({ id: r.id, duplicate: true });
    expect(await db.sunatDocument.count({ where: { tenantId: A, saleId } })).toBe(1);
    expect(await sendDocument(A, r.id)).toBe("SKIPPED");                              // ya aceptado: no se reenvía
  }, 240000);

  it("reglas del comprador: factura exige RUC válido; boleta desde S/ 700 exige DNI; venta sin importe no factura", async () => {
    const s1 = await sell(A, uA);
    await expect(emit(A, uA, s1, { kind: "FACTURA", customer: { docNumber: "20131312954", name: "ACME SAC", address: "Av. Lima 123" } })).rejects.toThrow(/RUC inválido/);
    const f = await emit(A, uA, s1, { kind: "FACTURA", customer: { docNumber: RUC, name: "ACME SAC", address: "Av. Lima 123" } });
    expect(await sendDocument(A, f.id)).toBe("ACCEPTED");
    expect(await getDoc(f.id)).toMatchObject({ kind: "FACTURA", serie: "F001", number: 1, customerDocType: "RUC", customerDocNumber: RUC });
    const big = await sell(A, uA, BIG);
    await expect(emit(A, uA, big)).rejects.toThrow(/700/);
    const ok = await emit(A, uA, big, { customer: { docNumber: "12345678", name: "Ana Pérez" } });
    expect(await getDoc(ok.id)).toMatchObject({ customerDocType: "DNI", customerDocNumber: "12345678", totalCents: BIG });
    await expect(emit(A, uA, "no-existe")).rejects.toThrow(/Venta no encontrada/);
  }, 240000);

  it("después de cobrar: boleta automática si está activa; mensaje (no excepción) si no se puede emitir", async () => {
    const s0 = await sell(A, uA);
    expect(await issueAfterSale({ tenantId: A, userId: uA, saleId: s0, choice: { type: "", customer: {} } })).toBeNull();
    expect(await db.sunatDocument.count({ where: { tenantId: A, saleId: s0 } })).toBe(0);   // autoIssue apagado
    await saveSunatConfig(cfgOf(A, uA, { autoIssue: true }));
    const s1 = await sell(A, uA);
    expect(await issueAfterSale({ tenantId: A, userId: uA, saleId: s1, choice: { type: "", customer: {} } })).toBeNull();
    expect(await db.sunatDocument.findFirstOrThrow({ where: { tenantId: A, saleId: s1 } })).toMatchObject({ kind: "BOLETA", status: "ACCEPTED" });
    const s2 = await sell(A, uA);
    expect(await issueAfterSale({ tenantId: A, userId: uA, saleId: s2, choice: { type: "FACTURA", customer: { docNumber: "123", name: "X", address: "Y" } } })).toMatch(/La venta se registró, pero el comprobante no: RUC inválido/);
    expect(await db.sale.count({ where: { id: s2, tenantId: A } })).toBe(1);               // la venta sigue guardada
    const sBig = await sell(A, uA, BIG);
    expect(await issueAfterSale({ tenantId: A, userId: uA, saleId: sBig, choice: { type: "", customer: {} } })).toMatch(/700/);
    await saveSunatConfig(cfgOf(A, uA, { autoIssue: false }));
  }, 240000);

  it("numeración sin saltos ni duplicados con emisiones simultáneas", async () => {
    const sales = [];
    for (let i = 0; i < 6; i++) sales.push(await sell(B, uB, 5000));
    const docs = await Promise.all(sales.map((s) => emit(B, uB, s)));
    const nums = (await db.sunatDocument.findMany({ where: { id: { in: docs.map((d) => d.id) } } })).map((d) => d.number).sort((a, b) => a - b);
    expect(nums).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await db.sunatSeries.findFirstOrThrow({ where: { tenantId: B, serie: "B001" } })).lastNumber).toBe(6);
    // un intento fallido (venta inexistente) no quema número
    await expect(emit(B, uB, "no-existe")).rejects.toThrow();
    const again = await emit(B, uB, await sell(B, uB, 5000));
    expect((await getDoc(again.id)).number).toBe(7);
  }, 360000);

  it("fallo del PSE: queda pendiente, espera creciente, el cron lo reenvía y no hay doble envío simultáneo", async () => {
    const id = (await emit(A, uA, await sell(A, uA))).id;
    const bad = down();
    expect(await sendDocument(A, id, { adapter: bad })).toBe("PENDING");
    const d1 = await getDoc(id);
    expect([d1.status, d1.attempts, d1.lastError]).toEqual(["PENDING", 1, "PSE caído (simulado)"]);
    expect(d1.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 30_000);          // ~1 min
    expect(d1.lockedUntil).toBeNull();
    // el cron todavía no lo toca (espera no vencida) ...
    let r = await processDue({ adapterFor: () => bad });
    expect((await getDoc(id)).attempts).toBe(1); expect(r.processed).toBeGreaterThanOrEqual(0);
    // ... y con la espera vencida lo reenvía y queda aceptado
    const good = new Scripted((d) => new MockSunatAdapter().issue(d));
    r = await processDue({ now: new Date(Date.now() + 3600_000), adapterFor: (t) => (t === A ? good : undefined) });
    expect((await getDoc(id)).status).toBe("ACCEPTED"); expect(r.ACCEPTED).toBeGreaterThanOrEqual(1);
    // envío simultáneo: solo uno ejecuta
    const id2 = (await emit(A, uA, await sell(A, uA))).id;
    const slow = new Scripted(async (d) => { await new Promise((ok) => setTimeout(ok, 800)); return new MockSunatAdapter().issue(d); });
    const out = await Promise.all([sendDocument(A, id2, { adapter: slow }), sendDocument(A, id2, { adapter: slow })]);
    expect(out.sort()).toEqual(["ACCEPTED", "SKIPPED"]);
    expect(slow.issued).toBe(1);
  }, 360000);

  it("reenvío tras respuesta perdida: primero consulta al PSE y no vuelve a emitir", async () => {
    const id = (await emit(A, uA, await sell(A, uA))).id;
    await sendDocument(A, id, { adapter: down() });                                     // intento 1 falló (quizá sí llegó)
    const a = new Scripted(() => { throw new Error("no debería emitirse"); }, () => ({ status: "ACCEPTED", code: "0", description: "ya existía", hash: "H1", qr: null, pdfUrl: null, xmlUrl: null, cdrUrl: null }));
    expect(await retryDocument({ tenantId: A, id, adapter: a })).toBe("ACCEPTED");
    expect([a.consulted, a.issued]).toEqual([1, 0]);
    expect(await getDoc(id)).toMatchObject({ status: "ACCEPTED", hash: "H1", lastError: null });
  }, 240000);

  it("rechazo de SUNAT: queda visible y se corrige y reenvía con el MISMO número", async () => {
    const saleId = await sell(A, uA);
    const id = (await emit(A, uA, saleId, { customer: { docNumber: "12345678", name: `Luis ${MOCK_REJECT}` } })).id;
    expect(await sendDocument(A, id)).toBe("REJECTED");
    const rej = await getDoc(id);
    expect([rej.status, rej.responseCode]).toEqual(["REJECTED", "2800"]); expect(rej.lastError).toContain("2800"); expect(rej.nextAttemptAt).toBeNull();
    expect(await processDue({ now: new Date(Date.now() + 99 * 3600_000) }).then(() => getDoc(id).then((d) => d.status))).toBe("REJECTED"); // el cron no reenvía rechazados
    await expect(retryDocument({ tenantId: A, id, customer: { docNumber: "123", name: "Luis" } })).rejects.toThrow(/DNI/);
    expect(await retryDocument({ tenantId: A, id, customer: { docNumber: "12345678", name: "Luis Torres" } })).toBe("ACCEPTED");
    const ok = await getDoc(id);
    expect([ok.status, ok.number, ok.serie, ok.customerName, ok.lastError]).toEqual(["ACCEPTED", rej.number, rej.serie, "Luis Torres", null]);
    await expect(retryDocument({ tenantId: A, id })).rejects.toThrow(/ya fue aceptado/);
  }, 240000);

  it("reintentos agotados: pasa a FALLÓ y el reintento manual lo recupera", async () => {
    const id = (await emit(A, uA, await sell(A, uA))).id;
    const bad = down();
    for (let i = 0; i < 8; i++) {
      await db.sunatDocument.updateMany({ where: { id }, data: { nextAttemptAt: new Date(Date.now() - 1000), lockedUntil: null } });
      await sendDocument(A, id, { adapter: bad });
    }
    expect(await getDoc(id)).toMatchObject({ status: "FAILED", attempts: 8, nextAttemptAt: null });
    expect(await sendDocument(A, id, { adapter: bad })).toBe("SKIPPED");               // FAILED no se reintenta solo
    expect(await retryDocument({ tenantId: A, id })).toBe("ACCEPTED");
  }, 360000);

  it("nota de crédito: total, vinculada, una sola, y marca el original como anulado", async () => {
    const id = (await emit(A, uA, await sell(A, uA, 23600))).id;
    await expect(createCreditNote({ tenantId: A, userId: uA, documentId: id, reason: "01", reasonText: "Cliente desistió" })).rejects.toThrow(/aceptado/);
    await sendDocument(A, id);
    await expect(createCreditNote({ tenantId: A, userId: uA, documentId: id, reason: "02", reasonText: "Error de RUC" })).rejects.toThrow(/solo aplica a facturas/);
    await expect(createCreditNote({ tenantId: A, userId: uA, documentId: id, reason: "01", reasonText: "x" })).rejects.toThrow(/motivo/i);
    const [n1, n2] = await Promise.allSettled([1, 2].map(() => createCreditNote({ tenantId: A, userId: uA, documentId: id, reason: "01", reasonText: "Anulación de la venta" })));
    expect([n1!.status, n2!.status].sort()).toEqual(["fulfilled", "rejected"]);     // concurrencia: una sola nota
    const ncId = (n1!.status === "fulfilled" ? n1!.value : (n2 as PromiseFulfilledResult<{ id: string }>).value).id;
    const nc = await getDoc(ncId);
    expect(nc).toMatchObject({ kind: "CREDIT_NOTE", serie: "BC01", number: 1, creditedDocumentId: id, totalCents: 23600, creditNoteReason: "01", status: "PENDING", saleId: null });
    expect(await sendDocument(A, ncId)).toBe("ACCEPTED");
    expect((await getDoc(id)).creditedAt).not.toBeNull();
    expect(await getDoc(ncId).then((d) => d.xml)).toContain("BillingReference");
    await expect(createCreditNote({ tenantId: A, userId: uA, documentId: id, reason: "01", reasonText: "Otra vez" })).rejects.toThrow(/anulado|ya tiene/);
    await expect(createCreditNote({ tenantId: A, userId: uA, documentId: ncId, reason: "01", reasonText: "Sobre una NC" })).rejects.toThrow(/nota de crédito/);
    // factura: serie propia FC01 y motivo 02 permitido
    const f = await emit(A, uA, await sell(A, uA), { kind: "FACTURA", customer: { docNumber: RUC, name: "ACME SAC", address: "Av. Lima 123" } });
    await sendDocument(A, f.id);
    const fn = await createCreditNote({ tenantId: A, userId: uA, documentId: f.id, reason: "02", reasonText: "RUC mal digitado" });
    expect(await getDoc(fn.id)).toMatchObject({ serie: "FC01", customerDocType: "RUC" });
  }, 360000);

  it("restricciones de la base de datos", async () => {
    const base = await db.sunatDocument.findFirstOrThrow({ where: { tenantId: A, kind: "FACTURA" } });
    const mk = (over: Record<string, unknown>) => db.sunatDocument.create({ data: { tenantId: A, kind: "BOLETA", provider: "MOCK", serie: "B001", number: 900_000 + ++seq, issueDate: "2026-11-18", saleId: key(), customerDocType: "NONE", customerName: "X", igvBp: 1800, taxableCents: 100, igvCents: 18, totalCents: 118, items: [], createdById: uA, ...over } as never });
    await expect(mk({ kind: "FACTURA", customerDocType: "DNI", customerDocNumber: "12345678" })).rejects.toThrow();     // factura solo RUC
    await expect(mk({ taxableCents: 100, igvCents: 19 })).rejects.toThrow();                                           // base + IGV = total
    await expect(mk({ totalCents: 0, taxableCents: 0, igvCents: 0 })).rejects.toThrow();
    await expect(mk({ customerDocType: "RUC", customerDocNumber: "123" })).rejects.toThrow();
    await expect(mk({ status: "ACCEPTED" })).rejects.toThrow();                                                        // aceptado exige acceptedAt
    await expect(mk({ saleId: null })).rejects.toThrow();                                                              // boleta exige venta
    await expect(mk({ kind: "CREDIT_NOTE", saleId: null })).rejects.toThrow();                                         // NC exige documento y motivo
    await expect(mk({ serie: base.serie, number: base.number, saleId: key() })).rejects.toThrow();                      // serie+número únicos
    await expect(mk({ saleId: base.saleId })).rejects.toThrow();                                                       // una venta, un comprobante
    await expect(db.sunatConfig.update({ where: { tenantId: A }, data: { serieBoleta: "X001" } })).rejects.toThrow();
    await expect(db.sunatConfig.update({ where: { tenantId: A }, data: { igvBp: 9000 } })).rejects.toThrow();
    await expect(db.$executeRaw`UPDATE "Tenant" SET "cashierExpenseLimitCents" = -1 WHERE "id" = ${A}`).rejects.toThrow();
  }, 240000);

  it("aislamiento entre establecimientos", async () => {
    const own = await db.sunatDocument.findFirstOrThrow({ where: { tenantId: A, kind: "BOLETA", status: "ACCEPTED", creditedAt: null } });
    const saleA = own.saleId!;
    await expect(emit(B, uB, saleA)).rejects.toThrow(/Venta no encontrada/);
    await expect(createCreditNote({ tenantId: B, userId: uB, documentId: own.id, reason: "01", reasonText: "Intento cruzado" })).rejects.toThrow(/no encontrado/);
    await expect(retryDocument({ tenantId: B, id: own.id })).rejects.toThrow(/no encontrado/);
    const pend = (await emit(A, uA, await sell(A, uA))).id;
    expect(await sendDocument(B, pend, { adapter: new MockSunatAdapter() })).toBe("SKIPPED");     // otro tenant no puede tomar el envío
    expect((await getDoc(pend)).status).toBe("PENDING");
    expect(await db.sunatDocument.count({ where: { tenantId: B, id: pend } })).toBe(0);
    const nA = await db.sunatDocument.findMany({ where: { tenantId: A, serie: "B001" }, select: { number: true } });
    expect(new Set(nA.map((d) => d.number)).size).toBe(nA.length);                                  // correlativos propios por tenant
    await setSunatEnabled(B, false);
    await expect(emit(B, uB, await sell(B, uB))).rejects.toThrow(/no está activa/);
    expect(await issueAfterSale({ tenantId: B, userId: uB, saleId: saleA, choice: { type: "BOLETA", customer: {} } })).toMatch(/no está activa/);
    await setSunatEnabled(B, true);
  }, 360000);

  it("archivos del PSE: se descargan solo de hosts permitidos y se guardan en la base", async () => {
    const id = (await emit(A, uA, await sell(A, uA))).id;
    const a = new Scripted(() => ({ status: "ACCEPTED", code: "0", description: "ok", hash: "h", qr: null, pdfUrl: "http://127.0.0.1:9/a.pdf", xmlUrl: "http://evil.example.com/a.xml", cdrUrl: null }));
    const urls: string[] = [];
    const fake = (async (u: string) => { urls.push(u); return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), { status: 200 }); }) as unknown as typeof fetch;
    await sendDocument(A, id, { adapter: a, fetchImpl: fake });
    const d = await getDoc(id);
    expect(Buffer.from(d.pdf!).toString()).toBe("%PDF-");
    expect(d.xml).toBeNull();
    expect(urls).toEqual(["http://127.0.0.1:9/a.pdf"]);                                              // el host ajeno nunca se contacta
    await fetchArtifacts(A, id, fake);
    expect(urls).toHaveLength(1);
  }, 240000);

  it("tope de gasto del cajero configurable por establecimiento (S/ 100.00 por defecto)", async () => {
    expect(await getCashierLimit(A)).toBe(10_000);
    const sale = await sell(A, uA, 50_000, "EFECTIVO"); expect(sale).toBeTruthy();                    // efectivo en el cajón
    const exp = (amountCents: number, tenantId = A, userId = uA) => createExpense({ tenantId, userId, canManage: false, category: "OPERATING_SUPPLIES", source: "CASH_DRAWER", amountCents, description: "Insumos de prueba", idempotencyKey: key() });
    await expect(exp(10_001)).rejects.toThrow(/S\/ 100\.00/);
    await exp(10_000);
    await setCashierLimit(A, 25_000);
    expect(await getCashierLimit(A)).toBe(25_000);
    await exp(20_000);                                                                              // ahora sí cabe
    await expect(exp(25_001)).rejects.toThrow(/S\/ 250\.00/);
    expect(await getCashierLimit(B)).toBe(10_000);                                                  // otro tenant no cambia
    await setCashierLimit(A, 0);
    await expect(exp(1)).rejects.toThrow(/S\/ 0\.00/);
    await expect(setCashierLimit(A, -1)).rejects.toThrow(/entre/);
    await expect(setCashierLimit(A, 1_000_001)).rejects.toThrow(/entre/);
    await expect(setCashierLimit(A, 10.5)).rejects.toThrow(/entre/);
    // el propietario/administrador no se ve afectado por el tope del cajero
    await createExpense({ tenantId: A, userId: uA, canManage: true, category: "OPERATING_SUPPLIES", source: "CASH_DRAWER", amountCents: 15_000, description: "Gasto mayor del admin", idempotencyKey: key() });
  }, 360000);
});
const BIG = 80_000;
