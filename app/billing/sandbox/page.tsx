import { notFound } from "next/navigation";
import { requireBillingUser } from "@/lib/rbac";
import { db } from "@/lib/db";
import { paymentProvider } from "@/lib/env";
import { formatSoles } from "@/lib/billing/money";
import { sandboxPayAction } from "@/actions/billing";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

// Pasarela SIMULADA: solo con PAYMENT_PROVIDER=MOCK y fuera de producción. No cobra nada.
export default async function SandboxPage({ searchParams }: { searchParams: Promise<{ invoice?: string }> }) {
  if (paymentProvider() !== "MOCK" || process.env.NODE_ENV === "production") notFound();
  const { tenantId } = await requireBillingUser();
  const { invoice } = await searchParams;
  const inv = invoice ? await db.saasInvoice.findFirst({ where: { id: invoice.replace(/[^\w-]/g, ""), tenantId, status: "PENDING" } }) : null;
  if (!inv) notFound();
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-bold">Pasarela de pruebas (sandbox)</h1>
      <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-300">SIMULADO: no se cobra dinero real.</p>
      <p>{inv.planName} · {formatSoles(inv.amountCents)}</p>
      <form action={sandboxPayAction}><input type="hidden" name="invoiceId" value={inv.id} /><Button>Simular pago aprobado</Button></form>
    </div>
  );
}
