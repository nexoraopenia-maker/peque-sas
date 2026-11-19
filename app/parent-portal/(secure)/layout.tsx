import type { Metadata } from "next";
import Link from "next/link";
import { requireGuardian } from "@/lib/portal/auth";
import { parentLogoutAction } from "@/actions/portal";

export const metadata: Metadata = { title: "Portal de padres", robots: { index: false, follow: false } };

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const g = await requireGuardian();
  return (
    <div className="mx-auto min-h-screen max-w-3xl p-4">
      <header className="mb-4 flex items-center justify-between border-b border-border pb-3">
        <Link href="/parent-portal" className="font-bold">{g.tenant.name}</Link>
        <form action={parentLogoutAction} className="text-sm"><span className="mr-3 text-muted-foreground">{g.fullName}</span><button className="underline">Salir</button></form>
      </header>
      {children}
    </div>
  );
}
