import Link from "next/link";
import { requireBillingUser } from "@/lib/rbac";
import { logoutAction } from "@/actions/auth";

export const dynamic = "force-dynamic";

// Pantalla de suscripción fuera del panel: accesible para el propietario incluso con el acceso bloqueado por impago.
export default async function BillingLayout({ children }: { children: React.ReactNode }) {
  const { user, locked } = await requireBillingUser();
  return (
    <div className="min-h-screen">
      <header className="flex flex-wrap items-center gap-4 border-b border-border px-4 py-3 text-sm">
        <b>PequesSaaS · Suscripción</b>
        {!locked && <Link href="/dashboard" className="underline">← Volver al panel</Link>}
        <span className="ml-auto text-muted-foreground">{user.name}</span>
        <form action={logoutAction}><button className="underline">Cerrar sesión</button></form>
      </header>
      <main className="mx-auto max-w-3xl p-4 md:p-8">{children}</main>
    </div>
  );
}
