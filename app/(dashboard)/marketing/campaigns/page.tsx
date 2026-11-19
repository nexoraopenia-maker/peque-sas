import Link from "next/link";
import { requirePermission } from "@/lib/rbac";
import { db } from "@/lib/db";
import { FREQUENCY_DAYS, SEGMENT_LABEL, segmentAudience } from "@/lib/marketing/campaigns";
import { createCampaignAction } from "@/actions/marketing";
import { ErrorBanner } from "@/components/dashboard/banner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";
const STATUS = { DRAFT: "Borrador", SENDING: "Enviando", SENT: "Enviada", CANCELLED: "Cancelada" } as const;

export default async function CampaignsPage({ searchParams }: { searchParams: Promise<{ e?: string; seg?: string }> }) {
  const { tenantId } = await requirePermission("marketing:manage");
  const { e, seg } = await searchParams;
  const campaigns = await db.campaign.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 50 });
  const segment = seg === "INACTIVE" || seg === "PREPAID_LOW" || seg === "BIRTHDAY_MONTH" ? seg : "BIRTHDAY_MONTH";
  const preview = await segmentAudience(tenantId, { segment, inactiveDays: 30, prepaidMinutesBelow: 60 });
  const sel = "h-9 rounded-md border border-input bg-background px-2 text-sm";
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between"><h1 className="text-2xl font-bold">Campañas</h1><Link href="/marketing" className="underline">← Marketing</Link></div>
      <ErrorBanner message={e} />
      <p className="rounded-md border border-border bg-card p-3 text-sm text-muted-foreground">
        Solo se escribe a apoderados con consentimiento comercial vigente (Ley 29733), con plantillas aprobadas por Meta, máximo una campaña cada {FREQUENCY_DAYS} días por persona. La plantilla debe incluir la indicación «Responde BAJA para no recibir más promociones».
      </p>
      <section className="space-y-2">
        <h2 className="font-semibold">Vista previa de audiencia</h2>
        <form method="GET" className="flex flex-wrap gap-2">
          <select name="seg" defaultValue={segment} className={sel}>{Object.entries(SEGMENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <Button variant="outline">Ver audiencia</Button>
        </form>
        <p className="text-sm">{preview.eligible.length} apoderados recibirían el mensaje · {preview.excludedNoConsent} excluidos por no tener consentimiento · {preview.excludedNoPhone} sin teléfono.</p>
      </section>
      <form action={createCampaignAction} className="grid gap-2 rounded-lg border border-border p-4 sm:grid-cols-3">
        <label className="text-sm">Nombre<Input name="name" required minLength={3} maxLength={80} /></label>
        <label className="text-sm">Segmento<select name="segment" defaultValue={segment} className={sel + " w-full"}>{Object.entries(SEGMENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="text-sm">Plantilla de Meta (nombre)<Input name="templateName" required placeholder="promo_cumple" pattern="[a-z0-9_]{1,200}" /></label>
        <label className="text-sm">Cupón (opcional)<Input name="couponCode" maxLength={32} /></label>
        <label className="text-sm">Inactivos desde (días)<Input name="inactiveDays" type="number" min="7" max="730" defaultValue={30} /></label>
        <label className="text-sm">Cuponera menor a (min)<Input name="prepaidMinutesBelow" type="number" min="1" max="5000" defaultValue={60} /></label>
        <Button className="sm:col-span-3">Crear campaña (borrador)</Button>
      </form>
      <ul className="divide-y divide-border rounded-lg border border-border text-sm">
        {campaigns.map((c) => <li key={c.id} className="flex justify-between p-2"><Link className="underline" href={`/marketing/campaigns/${c.id}`}>{c.name}</Link><span>{SEGMENT_LABEL[c.segment]} · {STATUS[c.status]}</span></li>)}
        {campaigns.length === 0 && <li className="p-2 text-muted-foreground">Sin campañas.</li>}
      </ul>
    </div>
  );
}
