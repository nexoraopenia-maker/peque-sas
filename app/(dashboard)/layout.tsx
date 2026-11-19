import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/rbac";
import { db } from "@/lib/db";
import { Sidebar } from "@/components/dashboard/nav";
import { featureEnabled } from "@/lib/plans/pure";
import { dueInfo } from "@/lib/subscriptions/pure";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  if (user.mustChangePassword) redirect("/change-password");
  if (user.role === "SUPERADMIN" || !user.tenant) redirect("/superadmin/dashboard");
  const t = user.tenant;
  const features = { WHATSAPP: featureEnabled(t, "WHATSAPP"), SUNAT: featureEnabled(t, "SUNAT"), REPORTS: featureEnabled(t, "REPORTS"), AUTOMATIONS: featureEnabled(t, "AUTOMATIONS") };
  // Aviso de suscripción solo para el propietario (quien puede pagar)
  const sub = user.role === "OWNER" && !t.plan.isDemo ? await db.subscription.findFirst({ where: { tenantId: t.id }, select: { status: true, currentPeriodEnd: true, graceUntil: true } }) : null;
  const due = dueInfo(sub, new Date());
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <Sidebar role={user.role} tenantName={t.name} userName={user.name} modules={t.modules} features={features} />
      <main className="flex-1 p-4 md:p-8">
        {due && (due.state === "DUE_SOON" || due.state === "PAST_DUE") && (
          <p role="status" className={`mb-4 rounded-md border p-3 text-sm ${due.state === "PAST_DUE" ? "border-red-500/40 bg-red-500/10 text-red-300" : "border-amber-500/40 bg-amber-500/10 text-amber-300"}`}>
            {due.state === "PAST_DUE" ? "Tu suscripción está vencida: paga para evitar el bloqueo del acceso." : `Tu suscripción vence en ${Math.max(due.daysLeft, 0)} día(s).`}{" "}
            <Link href="/billing" className="underline">Ver y pagar</Link>
          </p>
        )}
        {children}
      </main>
    </div>
  );
}
