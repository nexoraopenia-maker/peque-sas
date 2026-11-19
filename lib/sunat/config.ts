import "server-only";
import { db } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/whatsapp/crypto";
import { BillingError, retryBusy } from "@/lib/billing/service";
import type { SunatAdapter } from "./adapter";
import { MockSunatAdapter } from "./mock";
import { NubefactAdapter } from "./nubefact";
import { isValidRuc, validateApiUrl, validateSeries, clean } from "./pure";

export const getSunatConfig = (tenantId: string) => db.sunatConfig.findFirst({ where: { tenantId } });

/** Adaptador del establecimiento según su configuración. El token se descifra solo aquí, en el servidor. */
export function adapterFor(cfg: NonNullable<Awaited<ReturnType<typeof getSunatConfig>>>): SunatAdapter {
  if (cfg.provider === "MOCK") return new MockSunatAdapter();
  if (!cfg.sunatApiUrl || !cfg.sunatTokenEnc) throw new BillingError("Falta la URL o el token del PSE");
  const urlError = validateApiUrl(cfg.sunatApiUrl);
  if (urlError) throw new BillingError(urlError);
  return new NubefactAdapter({ apiUrl: cfg.sunatApiUrl, token: decryptSecret(cfg.sunatTokenEnc, cfg.tenantId, "sunatToken") });
}

export type SaveSunatConfig = {
  tenantId: string; userId: string; provider: "MOCK" | "NUBEFACT"; sunatApiUrl?: string; sunatToken?: string; rucEmisor: string; razonSocial: string;
  serieBoleta: string; serieFactura: string; serieNcBoleta: string; serieNcFactura: string; igvBp: number; autoIssue: boolean;
};

/** Guarda la configuración. Cambiar proveedor, URL, token o RUC invalida la prueba de conexión y desactiva la emisión hasta volver a probar. */
export async function saveSunatConfig(i: SaveSunatConfig) {
  const ruc = clean(i.rucEmisor, 11), razon = clean(i.razonSocial, 200);
  if (!isValidRuc(ruc)) throw new BillingError("RUC del emisor inválido");
  if (razon.length < 3) throw new BillingError("Indica la razón social del emisor");
  if (!Number.isInteger(i.igvBp) || i.igvBp < 0 || i.igvBp > 2500) throw new BillingError("IGV inválido");
  const series = { serieBoleta: i.serieBoleta.toUpperCase().trim(), serieFactura: i.serieFactura.toUpperCase().trim(), serieNcBoleta: i.serieNcBoleta.toUpperCase().trim(), serieNcFactura: i.serieNcFactura.toUpperCase().trim() };
  const se = validateSeries(series);
  if (se) throw new BillingError(se);
  const prev = await getSunatConfig(i.tenantId);
  let url: string | null = null, tokenEnc: string | null = null, last4: string | null = null;
  if (i.provider === "NUBEFACT") {
    url = clean(i.sunatApiUrl, 300);
    const ue = validateApiUrl(url);
    if (ue) throw new BillingError(ue);
    const t = i.sunatToken?.trim();
    if (t) { if (t.length < 8 || t.length > 500 || /\s/.test(t)) throw new BillingError("Token inválido"); tokenEnc = encryptSecret(t, i.tenantId, "sunatToken"); last4 = t.slice(-4); }
    else if (prev?.sunatTokenEnc) { tokenEnc = prev.sunatTokenEnc; last4 = prev.sunatTokenLast4; }
    else throw new BillingError("Ingresa el token del PSE");
  }
  const connChanged = !prev || prev.provider !== i.provider || prev.sunatApiUrl !== url || prev.sunatTokenEnc !== tokenEnc || prev.rucEmisor !== ruc;
  const data = {
    provider: i.provider, sunatApiUrl: url, sunatTokenEnc: tokenEnc, sunatTokenLast4: last4, rucEmisor: ruc, razonSocial: razon, ...series,
    igvBp: i.igvBp, autoIssue: i.autoIssue, updatedById: i.userId,
    ...(connChanged ? { enabled: false, lastTestOk: null, lastTestAt: null, lastTestError: null } : {}),
  };
  await retryBusy(() => db.sunatConfig.upsert({ where: { tenantId: i.tenantId }, create: { tenantId: i.tenantId, ...data }, update: data }));
}

export async function testSunatConfig(tenantId: string) {
  const cfg = await getSunatConfig(tenantId);
  if (!cfg) throw new BillingError("Configura primero el proveedor");
  let r: { ok: boolean; error?: string };
  try { r = await adapterFor(cfg).testConnection(); } catch (e) { r = { ok: false, error: e instanceof Error ? e.message : "error" }; }
  await retryBusy(() => db.sunatConfig.updateMany({ where: { tenantId }, data: { lastTestAt: new Date(), lastTestOk: r.ok, lastTestError: r.ok ? null : (r.error ?? "error").slice(0, 300), ...(r.ok ? {} : { enabled: false }) } }));
  return r;
}

export async function setSunatEnabled(tenantId: string, enable: boolean) {
  const cfg = await getSunatConfig(tenantId);
  if (!cfg) throw new BillingError("Configura primero el proveedor");
  if (enable && !cfg.lastTestOk) throw new BillingError("Prueba la conexión antes de activar la facturación electrónica");
  await retryBusy(() => db.sunatConfig.updateMany({ where: { tenantId }, data: { enabled: enable } }));
}
