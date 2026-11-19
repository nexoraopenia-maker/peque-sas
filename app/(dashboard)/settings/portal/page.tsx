import { requirePermission } from "@/lib/rbac";
import { db } from "@/lib/db";
import { setPortalAction } from "@/actions/portal-admin";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function PortalSettingsPage() {
  const { tenantId } = await requirePermission("settings:limited");
  const t = await db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { portalEnabled: true, portalCode: true } });
  const base = process.env.APP_URL ?? "";
  const link = t.portalCode ? `${base}/parent-portal/login?c=${t.portalCode}` : null;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Portal de padres</h1>
      <p className="text-sm text-muted-foreground">
        Los apoderados ingresan con el código del establecimiento, su DNI o teléfono y un código de acceso de un solo uso que tú generas desde Familias.
        Solo ven a sus propios hijos.
      </p>
      <section className="space-y-2 rounded-lg border border-border p-4 text-sm">
        <p>Estado: <b>{t.portalEnabled ? "Habilitado" : "Deshabilitado"}</b></p>
        {t.portalEnabled && t.portalCode && (
          <>
            <p>Código del establecimiento: <b className="font-mono text-base">{t.portalCode}</b></p>
            <p className="break-all">Enlace para compartir: <span className="font-mono">{link}</span></p>
          </>
        )}
        <div className="flex flex-wrap gap-2 pt-2">
          {!t.portalEnabled && <form action={setPortalAction}><input type="hidden" name="op" value="enable" /><Button>Habilitar portal</Button></form>}
          {t.portalEnabled && (
            <>
              <form action={setPortalAction}><input type="hidden" name="op" value="regenerate" /><Button variant="outline">Generar nuevo código del establecimiento</Button></form>
              <form action={setPortalAction}><input type="hidden" name="op" value="disable" /><Button variant="destructive">Deshabilitar portal</Button></form>
            </>
          )}
        </div>
        <p className="text-xs text-muted-foreground">Deshabilitar el portal cierra de inmediato todas las sesiones de apoderados. Generar un nuevo código invalida el enlace anterior.</p>
      </section>
    </div>
  );
}
