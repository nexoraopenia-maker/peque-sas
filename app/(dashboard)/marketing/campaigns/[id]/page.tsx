import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/rbac";
import { db } from "@/lib/db";
import { SEGMENT_LABEL } from "@/lib/marketing/campaigns";
import { cancelCampaignAction, sendBatchAction, startCampaignAction } from "@/actions/marketing";
import { ErrorBanner } from "@/components/dashboard/banner";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";
const RS = { PENDING: "Pendiente", SENT: "Enviado", FAILED: "Falló", SKIPPED: "Omitido" } as const;

export default async function CampaignPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ e?: string }> }) {
  const { tenantId } = await requirePermission("marketing:manage");
  const { id } = await params; const { e } = await searchParams;
  const c = await db.campaign.findFirst({ where: { id, tenantId } });
  if (!c) notFound();
  const recs = await db.campaignRecipient.findMany({ where: { tenantId, campaignId: id }, orderBy: { createdAt: "asc" }, take: 300, include: { guardian: { select: { fullName: true } } } });
  const count = (s: keyof typeof RS) => recs.filter((r) => r.status === s).length;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><h1 className="text-2xl font-bold">{c.name}</h1><Link href="/marketing/campaigns" className="underline">← Campañas</Link></div>
      <ErrorBanner message={e} />
      <p className="text-sm text-muted-foreground">{SEGMENT_LABEL[c.segment]} · plantilla <code>{c.templateName}</code>{c.couponCode ? ` · cupón ${c.couponCode}` : ""} · estado {c.status}</p>
      <div className="flex gap-2">
        {c.status === "DRAFT" && <form action={startCampaignAction}><input type="hidden" name="id" value={id} /><Button>Iniciar envío</Button></form>}
        {c.status === "SENDING" && <form action={sendBatchAction}><input type="hidden" name="id" value={id} /><Button>Enviar siguiente lote</Button></form>}
        {(c.status === "DRAFT" || c.status === "SENDING") && <form action={cancelCampaignAction}><input type="hidden" name="id" value={id} /><Button variant="destructive">Cancelar</Button></form>}
      </div>
      <p className="text-sm">Pendientes {count("PENDING")} · Enviados {count("SENT")} · Fallidos {count("FAILED")} · Omitidos {count("SKIPPED")}</p>
      <ul className="divide-y divide-border rounded-lg border border-border text-sm">
        {recs.map((r) => <li key={r.id} className="flex justify-between p-2"><span>{r.guardian.fullName}</span><span>{RS[r.status]}{r.reason && r.reason !== "enviando" ? ` · ${r.reason}` : ""}</span></li>)}
      </ul>
    </div>
  );
}
