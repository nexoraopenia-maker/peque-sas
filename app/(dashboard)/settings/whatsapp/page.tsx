import { requirePermission, requireFeature } from "@/lib/rbac";
import { tenantDb } from "@/lib/db/tenant";
import { getConfigView } from "@/lib/whatsapp/service";
import { DEFAULT_API_VERSION } from "@/lib/whatsapp/graph";
import { regenerateVerifyTokenAction, saveWhatsAppConfigAction, subscribeWhatsAppAction, testWhatsAppAction, toggleWhatsAppAction } from "@/actions/whatsapp";
import { ErrorBanner, OkBanner } from "@/components/dashboard/banner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";
const when = (d: Date | null) => (d ? d.toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short", timeZone: "America/Lima" }) : "—");
const ST = { PENDING: "Enviando", SENT: "Enviado", DELIVERED: "Entregado", READ: "Leído", FAILED: "Falló", RECEIVED: "Recibido" } as const;

export default async function WhatsAppSettingsPage({ searchParams }: { searchParams: Promise<{ e?: string; ok?: string }> }) {
  const { tenantId } = await requirePermission("whatsapp:configure");
  await requireFeature("WHATSAPP");
  const q = await searchParams;
  const c = await getConfigView(tenantId);
  const messages = c ? await tenantDb(tenantId).whatsAppMessage.findMany({ orderBy: { createdAt: "desc" }, take: 25, include: { conversation: { select: { waId: true } } } }) : [];
  const base = (process.env.APP_URL ?? "").replace(/\/+$/, "");
  const webhook = `${base || "https://TU-DOMINIO"}/api/webhooks/whatsapp`;
  const label = "block text-sm";
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">WhatsApp (Meta Cloud API)</h1>
      <ErrorBanner message={q.e} /><OkBanner message={q.ok} />
      <p className="text-sm text-muted-foreground">Cada establecimiento conecta su propio número de WhatsApp Business. Sigue la guía <code>docs/WHATSAPP_META_SETUP.md</code>. Los datos secretos se guardan cifrados y no se vuelven a mostrar.</p>

      <section className="space-y-2 rounded-lg border border-border p-4 text-sm">
        <h2 className="font-semibold">Estado</h2>
        {!c ? <p>Sin configurar.</p> : (
          <>
            <p>WhatsApp: <b className={c.enabled ? "text-green-300" : "text-amber-300"}>{c.enabled ? "Activo" : "Inactivo"}</b> · Última prueba: {c.lastTestAt ? `${when(c.lastTestAt)} — ${c.lastTestOk ? "correcta" : `falló (${c.lastTestError})`}` : "nunca"}</p>
            <p>Número: {c.displayPhoneNumber ?? "—"} · Nombre verificado: {c.verifiedName ?? "—"} · Calidad: {c.qualityRating ?? "—"} · Webhook suscrito: {c.subscribedAt ? when(c.subscribedAt) : "no"}</p>
            <div className="flex flex-wrap gap-2 pt-1">
              <form action={testWhatsAppAction}><Button size="sm" variant="outline">Probar conexión con Meta</Button></form>
              <form action={subscribeWhatsAppAction} className="flex items-center gap-2">
                <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="override" defaultChecked /> Usar la URL de este sistema para este WABA</label>
                <Button size="sm" variant="outline" disabled={!c.lastTestOk}>Suscribir webhook</Button>
              </form>
              <form action={toggleWhatsAppAction}><input type="hidden" name="enable" value={String(!c.enabled)} />
                <Button size="sm" variant={c.enabled ? "destructive" : "default"} disabled={!c.enabled && !c.lastTestOk}>{c.enabled ? "Desactivar" : "Activar"}</Button></form>
            </div>
          </>
        )}
      </section>

      <section className="space-y-2 rounded-lg border border-border p-4 text-sm">
        <h2 className="font-semibold">Webhook (copiar en Meta)</h2>
        <p>URL de devolución de llamada: <code className="break-all font-mono">{webhook}</code></p>
        {c ? <p>Verify token: <code className="break-all font-mono">{c.verifyToken || "(no disponible: vuelve a generarlo)"}</code></p> : <p className="text-muted-foreground">Se genera al guardar la configuración.</p>}
        {!base.startsWith("https://") && <p className="text-amber-300">APP_URL no es una URL https pública: Meta solo acepta webhooks https.</p>}
        {c && <form action={regenerateVerifyTokenAction}><Button size="sm" variant="outline">Generar nuevo verify token</Button></form>}
      </section>

      <form action={saveWhatsAppConfigAction} className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-2">
        <h2 className="font-semibold sm:col-span-2">Credenciales y plantillas</h2>
        <label className={label}>Phone Number ID<Input name="phoneNumberId" required defaultValue={c?.phoneNumberId} inputMode="numeric" /></label>
        <label className={label}>WABA ID<Input name="wabaId" required defaultValue={c?.wabaId} inputMode="numeric" /></label>
        <label className={label}>Access Token (System User permanente){c ? <span className="text-xs text-muted-foreground"> · guardado, termina en …{c.accessTokenLast4}</span> : null}
          <Input name="accessToken" type="password" autoComplete="off" placeholder={c ? "Déjalo vacío para conservar el actual" : "EAAB…"} required={!c} /></label>
        <label className={label}>App Secret (opcional){c?.hasAppSecret ? <span className="text-xs text-muted-foreground"> · guardado</span> : null}
          <Input name="appSecret" type="password" autoComplete="off" placeholder="Vacío = usar el App Secret global del sistema" /></label>
        <label className={label}>Versión de Graph API<Input name="apiVersion" defaultValue={c?.apiVersion ?? ""} placeholder={`Vacío = ${process.env.META_API_VERSION || DEFAULT_API_VERSION}`} /></label>
        <label className={label}>Código de país (Perú = 51)<Input name="countryCode" defaultValue={c?.countryCode ?? "51"} /></label>
        <label className={label}>Idioma de las plantillas<Input name="templateLanguage" defaultValue={c?.templateLanguage ?? "es"} /></label>
        <label className={label}>Teléfono del propietario (alertas de caja)<Input name="ownerAlertPhone" defaultValue="" placeholder={c?.ownerAlertPhone ? `Guardado: …${c.ownerAlertPhone.slice(-4)}` : "987 654 321"} /></label>
        <label className={label}>Plantilla: código del portal de padres<Input name="tplPortalCode" defaultValue={c?.tplPortalCode ?? ""} placeholder="codigo_portal" /></label>
        <label className={label}>Tipo de esa plantilla
          <select name="portalCodeTplKind" defaultValue={c?.portalCodeTplKind ?? "UTILITY"} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="UTILITY">Utilidad ({"{{1}}"} código, {"{{2}}"} minutos)</option><option value="AUTHENTICATION">Autenticación (botón copiar código)</option></select></label>
        <label className={label}>Plantilla: recordatorio de reserva<Input name="tplReservationReminder" defaultValue={c?.tplReservationReminder ?? ""} placeholder="recordatorio_reserva" /></label>
        <label className={label}>Plantilla: alerta de caja<Input name="tplCashAlert" defaultValue={c?.tplCashAlert ?? ""} placeholder="alerta_caja" /></label>
        <p className="text-xs text-muted-foreground sm:col-span-2">Sin plantilla aprobada solo se puede escribir a quien te escribió en las últimas 24 h (regla de Meta): sin plantilla del portal, el apoderado no podrá pedir su código por WhatsApp. Cambiar el número, el WABA o el token desactiva WhatsApp hasta una nueva prueba.</p>
        <Button className="sm:col-span-2">Guardar</Button>
      </form>

      {c && (
        <section className="space-y-2">
          <h2 className="font-semibold">Últimos mensajes</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground"><tr><th className="p-2">Fecha</th><th>Dir.</th><th>Contacto</th><th>Tipo</th><th>Motivo</th><th>Estado</th><th>Error</th></tr></thead>
              <tbody>
                {messages.map((m) => (
                  <tr key={m.id} className="border-t border-border">
                    <td className="p-2">{when(m.createdAt)}</td><td>{m.direction === "IN" ? "Entrada" : "Salida"}</td><td>…{m.conversation.waId.slice(-4)}</td>
                    <td>{m.type}{m.templateName ? ` (${m.templateName})` : ""}</td><td>{m.purpose ?? "—"}</td><td className={m.status === "FAILED" ? "text-red-400" : ""}>{ST[m.status]}</td><td>{m.errorCode ? `${m.errorCode}: ${m.errorDetail ?? ""}` : ""}</td>
                  </tr>
                ))}
                {messages.length === 0 && <tr><td className="p-2 text-muted-foreground" colSpan={7}>Sin mensajes todavía.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">No se muestran los textos de los mensajes recibidos (datos personales).</p>
        </section>
      )}
    </div>
  );
}
