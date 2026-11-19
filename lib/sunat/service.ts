import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { BillingError, retryBusy, type Tx } from "@/lib/billing/service";
import { limaDate } from "@/lib/utils/date";
import { SunatTransportError, type AdapterDoc, type AdapterResult, type SunatAdapter } from "./adapter";
import { adapterFor, getSunatConfig } from "./config";
import { canStore, hasFeature } from "@/lib/plans/limits";
import { featureMessage } from "@/lib/plans/pure";
import {
  CREDIT_REASON_LABEL, MAX_ATTEMPTS, buildDocItems, clean, docNumber, isAllowedFileUrl, nextAttemptAt, normalizeCustomer,
  type CreditReason, type Customer, type CustomerInput, type DocItem,
} from "./pure";

/**
 * Comprobantes electrónicos. Reglas:
 *  - tenantId siempre explícito; la numeración (serie+correlativo) se asigna en la MISMA transacción que crea el comprobante: sin saltos ni duplicados.
 *  - Un comprobante por venta (único tenantId+saleId) y una sola nota de crédito por comprobante (único tenantId+creditedDocumentId).
 *  - El envío al PSE NUNCA deshace la venta: si falla la conexión el comprobante queda PENDING y se reintenta con espera creciente.
 *  - Un reenvío primero consulta al PSE (por si el envío anterior llegó pero la respuesta se perdió).
 *  - Un comprobante rechazado se corrige y se reenvía con el MISMO número (SUNAT no lo tiene registrado).
 */
const TX = { maxWait: 10_000, timeout: 30_000 } as const;
const LOCK_MS = 2 * 60_000;
const MAX_FILE_BYTES = 3 * 1024 * 1024;
const isUnique = (e: unknown) => /UNIQUE|constraint/i.test(e instanceof Error ? e.message : String(e));
type Doc = NonNullable<Awaited<ReturnType<typeof db.sunatDocument.findFirst>>>;

async function allocNumber(tx: Tx, tenantId: string, serie: string): Promise<number> {
  await tx.$executeRaw`INSERT OR IGNORE INTO "SunatSeries" ("id","tenantId","serie","lastNumber") VALUES (${randomUUID()}, ${tenantId}, ${serie}, 0)`;
  await tx.$executeRaw`UPDATE "SunatSeries" SET "lastNumber" = "lastNumber" + 1 WHERE "tenantId" = ${tenantId} AND "serie" = ${serie}`;
  return (await tx.sunatSeries.findFirstOrThrow({ where: { tenantId, serie } })).lastNumber;
}

async function enabledConfig(tenantId: string) {
  const cfg = await getSunatConfig(tenantId);
  if (!cfg || !cfg.enabled) throw new BillingError("La facturación electrónica no está activa en este establecimiento");
  if (!(await hasFeature(tenantId, "SUNAT"))) throw new BillingError(featureMessage("SUNAT"));
  return cfg;
}

// ---------- Crear ----------
export type IssueForSale = { tenantId: string; userId: string; saleId: string; kind: "BOLETA" | "FACTURA"; customer: CustomerInput; now?: Date };

/** Crea (y numera) el comprobante de una venta. Idempotente: si la venta ya tiene comprobante devuelve ese. No lo envía. */
export async function createDocumentForSale(i: IssueForSale): Promise<{ id: string; duplicate: boolean }> {
  const cfg = await enabledConfig(i.tenantId);
  const prev = await db.sunatDocument.findFirst({ where: { tenantId: i.tenantId, saleId: i.saleId }, select: { id: true } });
  if (prev) return { id: prev.id, duplicate: true };
  const sale = await db.sale.findFirst({ where: { id: i.saleId, tenantId: i.tenantId }, include: { items: true } });
  if (!sale) throw new BillingError("Venta no encontrada");
  if (sale.totalCents <= 0) throw new BillingError("La venta no tiene importe a pagar: no genera comprobante");
  const cust = normalizeCustomer(i.kind, sale.totalCents, i.customer);
  if (!cust.ok) throw new BillingError(cust.error);
  const built = buildDocItems(sale.kind, sale.items.map((x) => ({ kind: x.kind, description: x.description, quantity: x.quantity, totalCents: x.totalCents })), sale.totalCents, cfg.igvBp);
  const serie = i.kind === "FACTURA" ? cfg.serieFactura : cfg.serieBoleta;
  try {
    const id = await retryBusy(() => db.$transaction(async (tx: Tx) => {
      const number = await allocNumber(tx, i.tenantId, serie);
      const d = await tx.sunatDocument.create({
        data: {
          tenantId: i.tenantId, kind: i.kind, provider: cfg.provider, serie, number, issueDate: limaDate(i.now), saleId: i.saleId,
          customerDocType: cust.value.docType, customerDocNumber: cust.value.docNumber, customerName: cust.value.name, customerAddress: cust.value.address, customerEmail: cust.value.email,
          igvBp: cfg.igvBp, taxableCents: built.taxableCents, igvCents: built.igvCents, totalCents: built.totalCents, items: built.items as never,
          nextAttemptAt: i.now ?? new Date(), createdById: i.userId,
        }, select: { id: true },
      });
      return d.id;
    }, TX));
    return { id, duplicate: false };
  } catch (e) {
    if (isUnique(e)) { // otra solicitud numeró primero la misma venta
      const again = await db.sunatDocument.findFirst({ where: { tenantId: i.tenantId, saleId: i.saleId }, select: { id: true } });
      if (again) return { id: again.id, duplicate: true };
    }
    throw e;
  }
}

/** Nota de crédito TOTAL de un comprobante aceptado. Una sola por comprobante. No la envía. */
export async function createCreditNote(i: { tenantId: string; userId: string; documentId: string; reason: CreditReason; reasonText: string; now?: Date }): Promise<{ id: string }> {
  const cfg = await enabledConfig(i.tenantId);
  if (!(i.reason in CREDIT_REASON_LABEL)) throw new BillingError("Motivo de nota de crédito inválido");
  const text = clean(i.reasonText, 250);
  if (text.length < 3) throw new BillingError("Describe el motivo de la nota de crédito");
  const orig = await db.sunatDocument.findFirst({ where: { id: i.documentId, tenantId: i.tenantId } });
  if (!orig) throw new BillingError("Comprobante no encontrado");
  if (orig.kind === "CREDIT_NOTE") throw new BillingError("No se puede emitir una nota de crédito sobre otra nota de crédito");
  if (orig.status !== "ACCEPTED") throw new BillingError("Solo se puede anular un comprobante aceptado por SUNAT");
  if (orig.creditedAt) throw new BillingError("Este comprobante ya fue anulado con una nota de crédito");
  if (i.reason === "02" && orig.kind !== "FACTURA") throw new BillingError("El motivo \"error en el RUC\" solo aplica a facturas");
  const serie = orig.kind === "FACTURA" ? cfg.serieNcFactura : cfg.serieNcBoleta;
  try {
    const id = await retryBusy(() => db.$transaction(async (tx: Tx) => {
      const fresh = await tx.sunatDocument.findFirst({ where: { id: orig.id, tenantId: i.tenantId, status: "ACCEPTED", creditedAt: null } });
      if (!fresh) throw new BillingError("Este comprobante ya no admite nota de crédito");
      const number = await allocNumber(tx, i.tenantId, serie);
      const d = await tx.sunatDocument.create({
        data: {
          tenantId: i.tenantId, kind: "CREDIT_NOTE", provider: cfg.provider, serie, number, issueDate: limaDate(i.now), creditedDocumentId: orig.id,
          creditNoteReason: i.reason, creditNoteReasonText: text,
          customerDocType: orig.customerDocType, customerDocNumber: orig.customerDocNumber, customerName: orig.customerName, customerAddress: orig.customerAddress, customerEmail: orig.customerEmail,
          igvBp: orig.igvBp, taxableCents: orig.taxableCents, igvCents: orig.igvCents, totalCents: orig.totalCents, items: orig.items as never,
          nextAttemptAt: i.now ?? new Date(), createdById: i.userId,
        }, select: { id: true },
      });
      return d.id;
    }, TX));
    return { id };
  } catch (e) {
    if (isUnique(e)) throw new BillingError("Este comprobante ya tiene una nota de crédito");
    throw e;
  }
}

// ---------- Enviar ----------
async function toAdapterDoc(d: Doc, cfg: { rucEmisor: string; razonSocial: string }): Promise<AdapterDoc> {
  const customer: Customer = { docType: d.customerDocType as Customer["docType"], docNumber: d.customerDocNumber, name: d.customerName, address: d.customerAddress, email: d.customerEmail };
  let credit: AdapterDoc["credit"];
  if (d.kind === "CREDIT_NOTE") {
    const ref = await db.sunatDocument.findFirst({ where: { id: d.creditedDocumentId!, tenantId: d.tenantId } });
    if (!ref) throw new BillingError("No se encontró el comprobante que modifica la nota de crédito");
    credit = { reason: d.creditNoteReason as CreditReason, reasonText: d.creditNoteReasonText ?? "", refKind: ref.kind as "BOLETA" | "FACTURA", refSerie: ref.serie, refNumber: ref.number };
  }
  return {
    kind: d.kind, serie: d.serie, number: d.number, issueDate: d.issueDate, igvBp: d.igvBp, emisor: { ruc: cfg.rucEmisor, razonSocial: cfg.razonSocial },
    customer, items: d.items as unknown as DocItem[], taxableCents: d.taxableCents, igvCents: d.igvCents, totalCents: d.totalCents, ...(credit ? { credit } : {}),
  };
}

/** Descarga PDF/XML del PSE al guardar. Solo hosts permitidos, https, sin redirecciones, con tope de tamaño y tiempo. */
async function download(url: string, apiUrl: string | null, fetchImpl: typeof fetch = fetch): Promise<Uint8Array | null> {
  if (!isAllowedFileUrl(url, apiUrl)) return null;
  try {
    const res = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_FILE_BYTES) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.length > 0 && buf.length <= MAX_FILE_BYTES ? buf : null;
  } catch { return null; }
}

/** Completa PDF/XML guardados localmente para un comprobante aceptado (si el PSE los dio por enlace). */
export async function fetchArtifacts(tenantId: string, id: string, fetchImpl?: typeof fetch): Promise<void> {
  const d = await db.sunatDocument.findFirst({ where: { id, tenantId, status: "ACCEPTED" } });
  if (!d) return;
  const cfg = await getSunatConfig(tenantId);
  const data: { xml?: string; pdf?: Buffer<ArrayBuffer> } = {};
  // Respeta el almacenamiento del plan: si no cabe, el archivo queda solo como enlace del PSE
  if (!d.xml && d.xmlUrl) { const b = await download(d.xmlUrl, cfg?.sunatApiUrl ?? null, fetchImpl); if (b && (await canStore(tenantId, b.length))) data.xml = Buffer.from(b).toString("utf8"); }
  if (!d.pdf && d.pdfUrl) { const b = await download(d.pdfUrl, cfg?.sunatApiUrl ?? null, fetchImpl); if (b && (await canStore(tenantId, b.length))) data.pdf = Buffer.from(b); }
  if (Object.keys(data).length) await retryBusy(() => db.sunatDocument.updateMany({ where: { id, tenantId }, data }));
}

async function applyResult(d: Doc, r: AdapterResult, fetchImpl?: typeof fetch) {
  const now = new Date();
  const common = {
    attempts: d.attempts + 1, lastAttemptAt: now, lockedUntil: null, responseCode: r.code, responseDescription: r.description?.slice(0, 500) ?? null,
    hash: r.hash, qr: r.qr, pdfUrl: r.pdfUrl, xmlUrl: r.xmlUrl, cdrUrl: r.cdrUrl,
  };
  if (r.status === "ACCEPTED") {
    const inline = (r.xml ? Buffer.byteLength(r.xml) : 0) + (r.pdf?.length ?? 0);
    const fits = inline === 0 || (await canStore(d.tenantId, inline));
    await retryBusy(() => db.$transaction(async (tx: Tx) => {
      await tx.sunatDocument.updateMany({
        where: { id: d.id, tenantId: d.tenantId },
        data: { ...common, status: "ACCEPTED", acceptedAt: now, nextAttemptAt: null, lastError: null, ...(fits && r.xml ? { xml: r.xml } : {}), ...(fits && r.pdf ? { pdf: Buffer.from(r.pdf) } : {}) },
      });
      if (d.kind === "CREDIT_NOTE" && d.creditedDocumentId) {
        await tx.sunatDocument.updateMany({ where: { id: d.creditedDocumentId, tenantId: d.tenantId, creditedAt: null }, data: { creditedAt: now } });
      }
    }, TX));
    await fetchArtifacts(d.tenantId, d.id, fetchImpl);
    return;
  }
  if (r.status === "REJECTED") {
    await retryBusy(() => db.sunatDocument.updateMany({ where: { id: d.id, tenantId: d.tenantId }, data: { ...common, status: "REJECTED", nextAttemptAt: null, lastError: `${r.code ?? ""} ${r.description ?? "Rechazado"}`.trim().slice(0, 500) } }));
    return;
  }
  // PENDING: enviado pero sin respuesta definitiva de SUNAT -> consultar luego
  const attempts = d.attempts + 1, next = nextAttemptAt(attempts, now);
  await retryBusy(() => db.sunatDocument.updateMany({
    where: { id: d.id, tenantId: d.tenantId },
    data: { ...common, status: next ? "PENDING" : "FAILED", nextAttemptAt: next, lastError: (r.description ?? "SUNAT aún no responde").slice(0, 500) },
  }));
}

async function applyTransportError(d: Doc, e: unknown) {
  const attempts = d.attempts + 1, next = nextAttemptAt(attempts);
  await retryBusy(() => db.sunatDocument.updateMany({
    where: { id: d.id, tenantId: d.tenantId },
    data: { attempts, lastAttemptAt: new Date(), lockedUntil: null, status: next ? "PENDING" : "FAILED", nextAttemptAt: next, lastError: (e instanceof Error ? e.message : "Error de conexión con el PSE").slice(0, 500) },
  }));
}

export type SendOutcome = "ACCEPTED" | "REJECTED" | "PENDING" | "FAILED" | "SKIPPED";

/** Envía (o reenvía) un comprobante PENDING. Un solo envío a la vez por comprobante (reserva con vencimiento). */
export async function sendDocument(tenantId: string, id: string, opts: { adapter?: SunatAdapter; fetchImpl?: typeof fetch } = {}): Promise<SendOutcome> {
  const now = new Date();
  const claim = await retryBusy(() => db.sunatDocument.updateMany({
    where: { id, tenantId, status: "PENDING", OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    data: { lockedUntil: new Date(now.getTime() + LOCK_MS) },
  }));
  if (claim.count !== 1) return "SKIPPED";
  const d = await db.sunatDocument.findFirstOrThrow({ where: { id, tenantId } });
  try {
    const cfg = await getSunatConfig(tenantId);
    if (!cfg || !cfg.enabled || !(await hasFeature(tenantId, "SUNAT"))) throw new SunatTransportError("La facturación electrónica está desactivada o no incluida en el plan: se reintentará al activarla");
    const adapter = opts.adapter ?? adapterFor(cfg);
    let r: AdapterResult | null = null;
    if (d.attempts > 0) r = await adapter.consult({ kind: d.kind, serie: d.serie, number: d.number }); // ¿ya llegó en un intento anterior?
    if (!r) r = await adapter.issue(await toAdapterDoc(d, cfg));
    await applyResult(d, r, opts.fetchImpl);
  } catch (e) {
    if (e instanceof SunatTransportError || e instanceof BillingError) await applyTransportError(d, e);
    else await applyTransportError(d, new Error("Error interno al enviar el comprobante"));
    if (!(e instanceof SunatTransportError || e instanceof BillingError)) console.error("[sunat] error inesperado", e);
  }
  const after = await db.sunatDocument.findFirstOrThrow({ where: { id, tenantId }, select: { status: true } });
  return after.status;
}

/** Reintento manual. Un REJECTED se puede corregir (datos del comprador) y reenviar con el mismo número; FAILED/PENDING se reinician. */
export async function retryDocument(i: { tenantId: string; id: string; customer?: CustomerInput; adapter?: SunatAdapter; fetchImpl?: typeof fetch }): Promise<SendOutcome> {
  const d = await db.sunatDocument.findFirst({ where: { id: i.id, tenantId: i.tenantId } });
  if (!d) throw new BillingError("Comprobante no encontrado");
  if (d.status === "ACCEPTED") throw new BillingError("El comprobante ya fue aceptado");
  const data: Record<string, unknown> = { status: "PENDING", attempts: d.status === "PENDING" ? d.attempts : 0, nextAttemptAt: new Date(), lockedUntil: null };
  if (i.customer && d.kind !== "CREDIT_NOTE") {
    const c = normalizeCustomer(d.kind as "BOLETA" | "FACTURA", d.totalCents, i.customer);
    if (!c.ok) throw new BillingError(c.error);
    Object.assign(data, { customerDocType: c.value.docType, customerDocNumber: c.value.docNumber, customerName: c.value.name, customerAddress: c.value.address, customerEmail: c.value.email });
  }
  // Tras un rechazo, SUNAT no tiene el comprobante: se reenvía como nuevo (attempts=0 evita la consulta previa)
  await retryBusy(() => db.sunatDocument.updateMany({ where: { id: d.id, tenantId: i.tenantId, status: { in: ["PENDING", "REJECTED", "FAILED"] } }, data }));
  return sendDocument(i.tenantId, d.id, { adapter: i.adapter, fetchImpl: i.fetchImpl });
}

/** Cron: reenvía los comprobantes pendientes cuya espera venció y completa archivos pendientes. Idempotente (reserva por comprobante). */
export async function processDue(opts: { limit?: number; adapterFor?: (tenantId: string) => SunatAdapter | undefined; fetchImpl?: typeof fetch; now?: Date } = {}) {
  const now = opts.now ?? new Date(), limit = opts.limit ?? 40;
  const due = await db.sunatDocument.findMany({ where: { status: "PENDING", nextAttemptAt: { lte: now } }, orderBy: { nextAttemptAt: "asc" }, take: limit, select: { id: true, tenantId: true } });
  const res: Record<SendOutcome, number> = { ACCEPTED: 0, REJECTED: 0, PENDING: 0, FAILED: 0, SKIPPED: 0 };
  for (const d of due) res[await sendDocument(d.tenantId, d.id, { adapter: opts.adapterFor?.(d.tenantId), fetchImpl: opts.fetchImpl })]++;
  const files = await db.sunatDocument.findMany({ where: { status: "ACCEPTED", OR: [{ pdf: null, pdfUrl: { not: null } }, { xml: null, xmlUrl: { not: null } }] }, take: 20, select: { id: true, tenantId: true } });
  for (const f of files) await fetchArtifacts(f.tenantId, f.id, opts.fetchImpl);
  return { processed: due.length, ...res, filesCompleted: files.length };
}

// ---------- Después de cobrar ----------
export type VoucherChoice = { type: "" | "BOLETA" | "FACTURA"; customer: CustomerInput };

/**
 * Se llama DESPUÉS de confirmar una venta. Nunca lanza: devuelve un mensaje si no se pudo emitir (la venta ya está guardada).
 * Sin elección: boleta automática solo si el establecimiento activó `autoIssue`. Con elección: emite lo pedido.
 */
export async function issueAfterSale(i: { tenantId: string; userId: string; saleId: string; choice: VoucherChoice; adapter?: SunatAdapter }): Promise<string | null> {
  try {
    const cfg = await getSunatConfig(i.tenantId);
    if (!cfg || !cfg.enabled || !(await hasFeature(i.tenantId, "SUNAT"))) return i.choice.type ? "No se emitió el comprobante electrónico: la facturación electrónica no está activa o no está incluida en tu plan" : null;
    const kind = i.choice.type || (cfg.autoIssue ? "BOLETA" : null);
    if (!kind) return null;
    const sale = await db.sale.findFirst({ where: { id: i.saleId, tenantId: i.tenantId }, select: { totalCents: true } });
    if (!sale || sale.totalCents <= 0) return null; // nada que cobrar (todo cubierto por saldo/puntos)
    const { id } = await createDocumentForSale({ tenantId: i.tenantId, userId: i.userId, saleId: i.saleId, kind, customer: i.choice.customer });
    await sendDocument(i.tenantId, id, { adapter: i.adapter });
    return null;
  } catch (e) {
    return e instanceof BillingError ? `La venta se registró, pero el comprobante no: ${e.message}` : "La venta se registró, pero el comprobante electrónico falló. Reintenta desde la venta.";
  }
}

/** Botón "Reintentar pendientes" del panel: solo los comprobantes de ESTE establecimiento. */
export async function retryPendingForTenant(tenantId: string, limit = 25) {
  const list = await db.sunatDocument.findMany({ where: { tenantId, status: "PENDING" }, orderBy: { createdAt: "asc" }, take: limit, select: { id: true } });
  const res: Record<SendOutcome, number> = { ACCEPTED: 0, REJECTED: 0, PENDING: 0, FAILED: 0, SKIPPED: 0 };
  for (const d of list) res[await sendDocument(tenantId, d.id)]++;
  return { total: list.length, ...res };
}
