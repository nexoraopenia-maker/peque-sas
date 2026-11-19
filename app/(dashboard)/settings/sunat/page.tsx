import { requirePermission, requireFeature } from "@/lib/rbac";
import { getSunatConfig } from "@/lib/sunat/config";
import { saveSunatConfigAction, testSunatAction, toggleSunatAction } from "@/actions/sunat";
import { ErrorBanner, OkBanner } from "@/components/dashboard/banner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";
const when = (d: Date | null) => (d ? d.toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short", timeZone: "America/Lima" }) : "—");

export default async function SunatSettingsPage({ searchParams }: { searchParams: Promise<{ e?: string; ok?: string }> }) {
  const { tenantId } = await requirePermission("settings:manage");
  await requireFeature("SUNAT");
  const q = await searchParams;
  const c = await getSunatConfig(tenantId);
  const label = "block text-sm";
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Facturación electrónica (SUNAT)</h1>
      <ErrorBanner message={q.e} /><OkBanner message={q.ok} />
      <p className="text-sm text-muted-foreground">Las boletas, facturas y notas de crédito se emiten mediante un PSE/OSE. El token se guarda cifrado y no se vuelve a mostrar. Guía: <code>docs/SUNAT_FACTURACION.md</code>.</p>

      <section className="space-y-2 rounded-lg border border-border p-4 text-sm">
        <h2 className="font-semibold">Estado</h2>
        {!c ? <p>Sin configurar.</p> : (
          <>
            <p>Proveedor: <b>{c.provider === "MOCK" ? "SIMULADO (sin validez tributaria)" : "Nubefact"}</b> · Facturación: <b className={c.enabled ? "text-green-300" : "text-amber-300"}>{c.enabled ? "Activa" : "Inactiva"}</b></p>
            <p>Última prueba: {c.lastTestAt ? `${when(c.lastTestAt)} — ${c.lastTestOk ? "correcta" : `falló (${c.lastTestError})`}` : "nunca"}</p>
            {c.provider === "MOCK" && <p className="text-amber-300">Modo simulado: los comprobantes NO se envían a SUNAT y no tienen validez tributaria. Úsalo solo para pruebas y demos.</p>}
            <div className="flex flex-wrap gap-2 pt-1">
              <form action={testSunatAction}><Button size="sm" variant="outline">Probar conexión</Button></form>
              <form action={toggleSunatAction}><input type="hidden" name="enable" value={String(!c.enabled)} />
                <Button size="sm" variant={c.enabled ? "destructive" : "default"} disabled={!c.enabled && !c.lastTestOk}>{c.enabled ? "Desactivar" : "Activar"}</Button></form>
            </div>
          </>
        )}
      </section>

      <form action={saveSunatConfigAction} className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-2">
        <h2 className="font-semibold sm:col-span-2">Datos del emisor y del PSE</h2>
        <label className={label}>Proveedor
          <select name="provider" defaultValue={c?.provider ?? "MOCK"} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
            <option value="MOCK">Simulado (pruebas)</option><option value="NUBEFACT">Nubefact</option>
          </select></label>
        <label className={label}>URL / ruta del PSE (Nubefact: https://api.nubefact.com/api/v1/…)<Input name="sunatApiUrl" defaultValue={c?.sunatApiUrl ?? ""} placeholder="https://api.nubefact.com/api/v1/…" /></label>
        <label className={label}>Token del PSE{c?.sunatTokenLast4 ? <span className="text-xs text-muted-foreground"> · guardado, termina en …{c.sunatTokenLast4}</span> : null}
          <Input name="sunatToken" type="password" autoComplete="off" placeholder={c?.sunatTokenLast4 ? "Vacío = conservar el actual" : "Solo para Nubefact"} /></label>
        <label className={label}>RUC del emisor<Input name="rucEmisor" required defaultValue={c?.rucEmisor} inputMode="numeric" maxLength={11} /></label>
        <label className={label + " sm:col-span-2"}>Razón social<Input name="razonSocial" required defaultValue={c?.razonSocial} maxLength={200} /></label>
        <label className={label}>Serie boleta<Input name="serieBoleta" required defaultValue={c?.serieBoleta ?? "B001"} maxLength={4} /></label>
        <label className={label}>Serie factura<Input name="serieFactura" required defaultValue={c?.serieFactura ?? "F001"} maxLength={4} /></label>
        <label className={label}>Serie nota de crédito (boleta)<Input name="serieNcBoleta" required defaultValue={c?.serieNcBoleta ?? "BC01"} maxLength={4} /></label>
        <label className={label}>Serie nota de crédito (factura)<Input name="serieNcFactura" required defaultValue={c?.serieNcFactura ?? "FC01"} maxLength={4} /></label>
        <label className={label}>IGV incluido en los precios (%)<Input name="igvPct" required defaultValue={((c?.igvBp ?? 1800) / 100).toString()} inputMode="decimal" /></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="autoIssue" defaultChecked={c?.autoIssue ?? false} /> Emitir boleta automáticamente en cada cobro</label>
        <p className="text-xs text-muted-foreground sm:col-span-2">Las series deben estar registradas en tu cuenta del PSE. Cambiar proveedor, URL, token o RUC desactiva la facturación hasta volver a probar la conexión.</p>
        <Button className="sm:col-span-2">Guardar</Button>
      </form>
    </div>
  );
}
