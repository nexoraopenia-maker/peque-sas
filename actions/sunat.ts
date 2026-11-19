"use server";
import { revalidatePath } from "next/cache";
import { requirePermission, requireFeature } from "@/lib/rbac";
import { BillingError } from "@/lib/billing/service";
import { saveSunatConfig, setSunatEnabled, testSunatConfig } from "@/lib/sunat/config";
import { createCreditNote, createDocumentForSale, retryDocument, retryPendingForTenant, sendDocument } from "@/lib/sunat/service";
import { voucherFromForm } from "@/lib/sunat/form";
import { CREDIT_REASON_LABEL, type CreditReason } from "@/lib/sunat/pure";
import { done, doneOk } from "@/lib/utils/flow";
import { audit } from "@/lib/audit";

const CFG = "/settings/sunat", PANEL = "/reports/invoices";
const text = (f: FormData, k: string) => String(f.get(k) ?? "");
async function guard<T>(path: string, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) { if (e instanceof BillingError) done(path, e.message); throw e; }
}

// ----- Configuración (solo el propietario: contiene el token del PSE) -----
export async function saveSunatConfigAction(form: FormData) {
  const { user, tenantId } = await requirePermission("settings:manage");
  await requireFeature("SUNAT");
  const provider = text(form, "provider") === "NUBEFACT" ? "NUBEFACT" : "MOCK";
  await guard(CFG, () => saveSunatConfig({
    tenantId, userId: user.id, provider, sunatApiUrl: text(form, "sunatApiUrl"), sunatToken: text(form, "sunatToken"), rucEmisor: text(form, "rucEmisor"), razonSocial: text(form, "razonSocial"),
    serieBoleta: text(form, "serieBoleta"), serieFactura: text(form, "serieFactura"), serieNcBoleta: text(form, "serieNcBoleta"), serieNcFactura: text(form, "serieNcFactura"),
    igvBp: Math.round(Number(text(form, "igvPct")) * 100), autoIssue: form.get("autoIssue") === "on",
  }));
  await audit({ tenantId, actorId: user.id, action: "sunat.config.save", entity: "SunatConfig", metadata: { provider } });
  revalidatePath(CFG); doneOk(CFG, "Configuración guardada. Prueba la conexión para poder activarla.");
}
export async function testSunatAction() {
  const { user, tenantId } = await requirePermission("settings:manage");
  await requireFeature("SUNAT");
  const r = await guard(CFG, () => testSunatConfig(tenantId));
  await audit({ tenantId, actorId: user.id, action: "sunat.config.test", entity: "SunatConfig", metadata: { ok: r.ok } });
  revalidatePath(CFG);
  if (!r.ok) done(CFG, `La prueba falló: ${r.error}`);
  doneOk(CFG, "Conexión verificada (alcance y credenciales; no se emitió ningún comprobante)");
}
export async function toggleSunatAction(form: FormData) {
  const { user, tenantId } = await requirePermission("settings:manage");
  await requireFeature("SUNAT");
  const enable = text(form, "enable") === "true";
  await guard(CFG, () => setSunatEnabled(tenantId, enable));
  await audit({ tenantId, actorId: user.id, action: "sunat.config.toggle", entity: "SunatConfig", metadata: { enabled: enable } });
  revalidatePath(CFG); doneOk(CFG, enable ? "Facturación electrónica activada" : "Facturación electrónica desactivada");
}

// ----- Emisión manual desde la venta -----
export async function issueDocumentAction(form: FormData) {
  const { user, tenantId } = await requirePermission("sunat:issue");
  await requireFeature("SUNAT");
  const saleId = text(form, "saleId"), back = `/cash-register/sales/${saleId.replace(/[^\w-]/g, "")}`;
  const v = voucherFromForm(form);
  const id = await guard(back, async () => {
    const r = await createDocumentForSale({ tenantId, userId: user.id, saleId, kind: v.type || "BOLETA", customer: v.customer });
    if (!r.duplicate) await audit({ tenantId, actorId: user.id, action: "sunat.issue", entity: "SunatDocument", entityId: r.id, metadata: { saleId } });
    return r.id;
  });
  await sendDocument(tenantId, id);
  revalidatePath(back); done(back);
}

// ----- Panel gerencial -----
export async function retryDocumentAction(form: FormData) {
  const { user, tenantId } = await requirePermission("sunat:manage");
  await requireFeature("SUNAT");
  const id = text(form, "id").replace(/[^\w-]/g, ""), back = `${PANEL}/${id}`;
  const correct = text(form, "vDoc") || text(form, "vName");
  const status = await guard(back, () => retryDocument({
    tenantId, id, ...(correct ? { customer: { docType: text(form, "kind") === "FACTURA" ? "RUC" : text(form, "vDoc") ? "DNI" : "NONE", docNumber: text(form, "vDoc"), name: text(form, "vName"), address: text(form, "vAddress"), email: text(form, "vEmail") } } : {}) }));
  await audit({ tenantId, actorId: user.id, action: "sunat.retry", entity: "SunatDocument", entityId: id, metadata: { status } });
  revalidatePath(PANEL); revalidatePath(back);
  doneOk(back, status === "ACCEPTED" ? "Comprobante aceptado" : `Estado: ${status}`);
}
export async function retryAllAction() {
  const { user, tenantId } = await requirePermission("sunat:manage");
  await requireFeature("SUNAT");
  const r = await retryPendingForTenant(tenantId);
  await audit({ tenantId, actorId: user.id, action: "sunat.retry_all", entity: "SunatDocument", metadata: { total: r.total, accepted: r.ACCEPTED } });
  revalidatePath(PANEL);
  doneOk(PANEL, `Reintentados ${r.total}: ${r.ACCEPTED} aceptados, ${r.REJECTED} rechazados, ${r.PENDING + r.FAILED} siguen pendientes`);
}
export async function creditNoteAction(form: FormData) {
  const { user, tenantId } = await requirePermission("sunat:manage");
  await requireFeature("SUNAT");
  const documentId = text(form, "id").replace(/[^\w-]/g, ""), back = `${PANEL}/${documentId}`;
  const reason = text(form, "reason") as CreditReason;
  if (!(reason in CREDIT_REASON_LABEL)) done(back, "Motivo inválido");
  const nc = await guard(back, () => createCreditNote({ tenantId, userId: user.id, documentId, reason, reasonText: text(form, "reasonText") }));
  await audit({ tenantId, actorId: user.id, action: "sunat.credit_note", entity: "SunatDocument", entityId: nc.id, metadata: { documentId, reason } });
  const status = await sendDocument(tenantId, nc.id);
  revalidatePath(PANEL); revalidatePath(back);
  doneOk(`${PANEL}/${nc.id}`, status === "ACCEPTED" ? "Nota de crédito aceptada" : `Nota de crédito creada (estado: ${status})`);
}
