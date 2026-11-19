import { requirePermission } from "@/lib/rbac";
import { hasPermission } from "@/lib/rbac/permissions";
import { tenantDb } from "@/lib/db/tenant";
import { FamilyForm, PickupForm } from "./form";
import { revokeAuthorizedPickupAction } from "@/actions/pickups";
import { randomUUID } from "node:crypto";
import { sellPackageAction } from "@/actions/prepaid";
import { tenantHasModule } from "@/lib/plans/modules";
import { formatSoles } from "@/lib/billing/money";
import { PaymentFields } from "@/components/dashboard/payment-fields";
import { ErrorBanner } from "@/components/dashboard/banner";
import { AccessCodeForm } from "@/components/portal/access-code-form";
import { loadActive } from "@/lib/whatsapp/service";
import { setConsentAction } from "@/actions/marketing";
import { blockGuardianAction, revokeAccessAction } from "@/actions/portal-admin";

export default async function FamiliesPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  const { user, tenantId } = await requirePermission("families:read");
  const { e } = await searchParams;
  const waActive = !!(await loadActive(tenantId));
  const sellPackages = hasPermission(user.role, "cash:use") && tenantHasModule(user.tenant?.modules, "PLAYGROUND");
  const packages = sellPackages ? await tenantDb(tenantId).prepaidPackage.findMany({ where: { isActive: true }, orderBy: { minutes: "asc" } }) : [];
  const children = await tenantDb(tenantId).child.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { guardians: { include: { guardian: true } }, authorizedPickups: { where: { isActive: true } } },
  });
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Familias</h1>
      <ErrorBanner message={e} />
      {hasPermission(user.role, "families:write") && <FamilyForm />}
      <ul className="divide-y divide-border rounded-lg border border-border">
        {children.length === 0 && <li className="p-4 text-sm text-muted-foreground">Aún no hay familias registradas.</li>}
        {children.map((c) => (
          <li key={c.id} className="p-4">
            <p className="font-medium">{c.fullName}</p>
            <p className="text-sm text-muted-foreground">
              {c.guardians.map((g) => `${g.guardian.fullName}${g.guardian.phone ? ` · ${g.guardian.phone}` : ""}`).join(", ")}
            </p>
            {hasPermission(user.role, "families:write") && user.tenant?.portalEnabled && (
              <div className="mt-2 space-y-1 text-sm">
                <p className="text-muted-foreground">Portal de padres:</p>
                {c.guardians.map((g) => (
                  <div key={g.guardianId} className="flex flex-wrap items-center gap-2">
                    <span>{g.guardian.fullName}{g.guardian.portalBlocked ? " (bloqueado)" : ""}</span>
                    <AccessCodeForm guardianId={g.guardianId} enabled={!g.guardian.portalBlocked} waActive={waActive} />
                    <form action={revokeAccessAction}><input type="hidden" name="guardianId" value={g.guardianId} /><button className="text-xs underline">Cerrar sesiones</button></form>
                    <form action={blockGuardianAction}><input type="hidden" name="guardianId" value={g.guardianId} /><input type="hidden" name="block" value={String(!g.guardian.portalBlocked)} /><button className="text-xs underline">{g.guardian.portalBlocked ? "Desbloquear" : "Bloquear acceso"}</button></form>
                  </div>
                ))}
              </div>
            )}
            {hasPermission(user.role, "families:write") && (
              <div className="mt-2 space-y-1 text-sm">
                <p className="text-muted-foreground">Promociones por WhatsApp (consentimiento, Ley 29733):</p>
                {c.guardians.map((g) => (
                  <form key={g.guardianId} action={setConsentAction} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="guardianId" value={g.guardianId} />
                    <input type="hidden" name="granted" value={g.guardian.marketingConsent ? "0" : "1"} />
                    <input type="hidden" name="source" value="FORM" />
                    <span>{g.guardian.fullName}: {g.guardian.marketingConsent ? `autorizó (${g.guardian.marketingConsentSource ?? ""}${g.guardian.marketingConsentAt ? ` · ${g.guardian.marketingConsentAt.toLocaleDateString("es-PE", { timeZone: "America/Lima" })}` : ""})` : g.guardian.marketingRevokedAt ? "revocó" : "sin autorización"}</span>
                    {!g.guardian.marketingConsent && <input name="evidence" required minLength={3} maxLength={200} placeholder="Cómo lo autorizó (ej. formulario firmado)" className="h-8 w-64 rounded-md border border-input bg-background px-2 text-xs" />}
                    <button className="text-xs underline">{g.guardian.marketingConsent ? "Revocar" : "Registrar autorización"}</button>
                  </form>
                ))}
              </div>
            )}
            <div className="mt-2 text-sm">
              <p className="text-muted-foreground">Autorizados a recoger: {c.guardians.filter((g) => g.canPickup).map((g) => g.guardian.fullName).join(", ") || "—"}</p>
              {c.authorizedPickups.map((a) => (
                <form key={a.id} action={revokeAuthorizedPickupAction} className="flex items-center gap-2">
                  <input type="hidden" name="id" value={a.id} />
                  <span>{a.fullName}{a.relationship ? ` (${a.relationship})` : ""}{a.dni ? ` · DNI ${a.dni}` : ""}</span>
                  {hasPermission(user.role, "families:write") && <button className="text-xs underline">Quitar</button>}
                </form>
              ))}
              {hasPermission(user.role, "families:write") && <PickupForm childId={c.id} />}
            </div>
            {sellPackages && (
              <div className="mt-2 text-sm">
                <p className="text-muted-foreground">Cuponera: saldo {c.prepaidMinutes} min</p>
                {packages.length > 0 && (
                  <form action={sellPackageAction} className="mt-1 flex flex-wrap items-center gap-2">
                    <input type="hidden" name="childId" value={c.id} /><input type="hidden" name="key" value={randomUUID()} />
                    <select name="packageId" required className="h-8 rounded-md border border-input bg-background px-2 text-sm">
                      {packages.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.minutes} min · {formatSoles(p.priceCents)}</option>)}
                    </select>
                    <PaymentFields />
                    <button className="h-8 rounded-md border border-input px-3 text-sm">Vender cuponera</button>
                  </form>
                )}
              </div>
            )}
            {(c.allergies || c.medicalAlerts) && (
              <p className="mt-1 text-sm text-amber-400">⚠ {[c.allergies, c.medicalAlerts].filter(Boolean).join(" · ")}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
