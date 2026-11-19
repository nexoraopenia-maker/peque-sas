import type { Metadata } from "next";
import { ParentLoginForm, RequestCodeForm } from "./form";

export const metadata: Metadata = { title: "Portal de padres", robots: { index: false, follow: false } };

export default async function ParentLoginPage({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const { c } = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-bold">Portal de padres</h1>
      <p className="text-sm text-muted-foreground">Pide tu código de acceso en recepción. Cada código sirve una sola vez y vence a los 15 minutos.</p>
      <ParentLoginForm portalCode={(c ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12)} />
      <RequestCodeForm portalCode={(c ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12)} />
    </main>
  );
}
