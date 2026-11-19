import Link from "next/link";
import { notFound } from "next/navigation";
import { requireModule, requirePermission } from "@/lib/rbac";
import { hasPermission } from "@/lib/rbac/permissions";
import { tenantDb } from "@/lib/db/tenant";
import { ErrorBanner } from "@/components/dashboard/banner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { saveProfileAction } from "@/actions/daycare";

export const dynamic = "force-dynamic";

export default async function ChildProfilePage({ params, searchParams }: { params: Promise<{ childId: string }>; searchParams: Promise<{ e?: string }> }) {
  await requireModule("DAYCARE");
  const { user, tenantId } = await requirePermission("daycare:attendance");
  const { childId } = await params;
  const { e } = await searchParams;
  const tdb = tenantDb(tenantId);
  // findFirst con tenantId inyectado: un id de otro establecimiento da 404
  const child = await tdb.child.findFirst({ where: { id: childId }, include: { guardians: { include: { guardian: true } }, authorizedPickups: { where: { isActive: true } } } });
  if (!child) notFound();
  const profile = await tdb.daycareProfile.findFirst({ where: { childId } });
  const canEdit = hasPermission(user.role, "daycare:manage");
  const v = (x?: string | null) => x ?? "";
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><h1 className="text-2xl font-bold">Ficha: {child.fullName}</h1><Link href="/daycare" className="underline">← Guardería</Link></div>
      <ErrorBanner message={e} />
      <section className="rounded-lg border border-border p-4 text-sm">
        <p>Nacimiento: {child.birthDate ? child.birthDate.toISOString().slice(0, 10) : "—"}</p>
        <p className="text-amber-400">Alergias: {v(child.allergies) || "—"} · Alertas médicas: {v(child.medicalAlerts) || "—"}</p>
        <p>Apoderados: {child.guardians.map((g) => `${g.guardian.fullName}${g.guardian.phone ? ` (${g.guardian.phone})` : ""}${g.canPickup ? "" : " [no recoge]"}`).join(", ")}</p>
        <p>Autorizados a recoger: {child.authorizedPickups.map((a) => a.fullName).join(", ") || "—"}</p>
      </section>
      <form action={saveProfileAction} className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-2">
        <input type="hidden" name="childId" value={childId} />
        <Input name="bloodType" placeholder="Grupo sanguíneo" defaultValue={v(profile?.bloodType)} disabled={!canEdit} />
        <Input name="insurance" placeholder="Seguro" defaultValue={v(profile?.insurance)} disabled={!canEdit} />
        <Input name="pediatrician" placeholder="Pediatra" defaultValue={v(profile?.pediatrician)} disabled={!canEdit} />
        <Input name="pediatricianPhone" placeholder="Teléfono del pediatra" defaultValue={v(profile?.pediatricianPhone)} disabled={!canEdit} />
        <Input name="emergencyContactName" placeholder="Contacto de emergencia" defaultValue={v(profile?.emergencyContactName)} disabled={!canEdit} />
        <Input name="emergencyContactPhone" placeholder="Teléfono de emergencia" defaultValue={v(profile?.emergencyContactPhone)} disabled={!canEdit} />
        <Input name="medications" placeholder="Medicamentos" defaultValue={v(profile?.medications)} disabled={!canEdit} className="sm:col-span-2" />
        <Input name="dietaryNotes" placeholder="Indicaciones de alimentación" defaultValue={v(profile?.dietaryNotes)} disabled={!canEdit} className="sm:col-span-2" />
        <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="photoConsent" defaultChecked={profile?.photoConsent} disabled={!canEdit} /> Autorización para fotografías</label>
        {canEdit && <Button className="sm:col-span-2">Guardar ficha</Button>}
      </form>
    </div>
  );
}
