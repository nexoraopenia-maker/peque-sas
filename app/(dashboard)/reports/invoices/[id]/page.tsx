import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/rbac";
import { db } from "@/lib/db";
import { formatSoles } from "@/lib/billing/money";
import { CREDIT_REASON_LABEL, KIND_NAME, docNumber, isAllowedFileUrl, type DocItem } from "@/lib/sunat/pure";
import { creditNoteAction, retryDocumentAction } from "@/actions/sunat";
import { ErrorBanner, OkBanner } from "@/components/dashboard/banner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";
const ST = { PENDING: "Pendiente", ACCEPTED: "Aceptado", REJECTED: "Rechazado", FAILED: "Falló" } as const;
const when = (d: Date | null) => (d ? d.toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short", timeZone: "America/Lima" }) : "—");

export default async function InvoiceDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ e?: string; ok?: string }> }) {
  const { tenantId } = await requirePermission("sunat:manage");
  const { id } = await params, q = await searchParams;
  const d = await db.sunatDocument.findFirst({ where: { id, tenantId }, omit: { pdf: true, xml: true } });
  if (!d) notFound();
  const [cfg, nc, orig, files] = await Promise.all([
    db.sunatConfig.findFirst({ where: { tenantId }, select: { sunatApiUrl: true } }),
    d.kind === "CREDIT_NOTE" ? null : db.sunatDocument.findFirst({ where: { tenantId, creditedDocumentId: d.id }, select: { id: true, serie: true, number: true, status: true } }),
    d.creditedDocumentId ? db.sunatDocument.findFirst({ where: { tenantId, id: d.creditedDocumentId }, select: { id: true, serie: true, number: true } }) : null,
    db.sunatDocument.findFirst({ where: { id, tenantId }, select: { pdf: true, xml: true } }),
  ]);
  const items = d.items as unknown as DocItem[];
  const input = "h-9 rounded-md border border-input bg-background px-2 text-sm";
  const ext = (u: string | null) => (u && isAllowedFileUrl(u, cfg?.sunatApiUrl ?? null) ? u : null);
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <p className="text-sm"><Link href="/reports/invoices" className="underline">← Comprobantes</Link></p>
      <h1 className="text-2xl font-bold">{KIND_NAME[d.kind]} {docNumber(d.serie, d.number)}</h1>
      <ErrorBanner message={q.e} /><OkBanner message={q.ok} />
      {d.provider === "MOCK" && <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-300">SIMULADO: este comprobante no fue enviado a SUNAT y no tiene validez tributaria.</p>}
      <section className="space-y-1 rounded-lg border border-border p-3 text-sm">
        <p>Estado: <b>{ST[d.status]}</b>{d.creditedAt ? ` · anulado con nota de crédito el ${when(d.creditedAt)}` : ""} · Emisión: {d.issueDate} · Intentos: {d.attempts}</p>
        <p>Respuesta SUNAT/PSE: {d.responseCode ?? "—"} {d.responseDescription ?? ""}</p>
        {d.lastError && <p className="text-red-300">Error: {d.lastError}</p>}
        {d.status === "PENDING" && d.nextAttemptAt && <p className="text-amber-300">Próximo reintento automático: {when(d.nextAttemptAt)}</p>}
        <p>Cliente: {d.customerName} ({d.customerDocType === "NONE" ? "sin documento" : `${d.customerDocType} ${d.customerDocNumber}`}){d.customerAddress ? ` · ${d.customerAddress}` : ""}</p>
        {orig && <p>Modifica: <Link className="underline" href={`/reports/invoices/${orig.id}`}>{docNumber(orig.serie, orig.number)}</Link> · Motivo: {d.creditNoteReason ? CREDIT_REASON_LABEL[d.creditNoteReason as keyof typeof CREDIT_REASON_LABEL] : ""} — {d.creditNoteReasonText}</p>}
        {nc && <p>Nota de crédito: <Link className="underline" href={`/reports/invoices/${nc.id}`}>{docNumber(nc.serie, nc.number)}</Link> ({ST[nc.status]})</p>}
        {d.hash && <p className="break-all text-xs text-muted-foreground">Hash: {d.hash}</p>}
      </section>
      <section className="rounded-lg border border-border p-3 text-sm">
        {items.map((i, n) => <p key={n} className="flex justify-between"><span>{i.description}{i.quantity > 1 ? ` × ${i.quantity}` : ""}</span><span>{formatSoles(i.totalCents)}</span></p>)}
        <p className="mt-2 flex justify-between border-t border-border pt-2 text-muted-foreground"><span>Op. gravada</span><span>{formatSoles(d.taxableCents)}</span></p>
        <p className="flex justify-between text-muted-foreground"><span>IGV ({d.igvBp / 100}%)</span><span>{formatSoles(d.igvCents)}</span></p>
        <p className="flex justify-between text-base font-bold"><span>Total</span><span>{formatSoles(d.totalCents)}</span></p>
      </section>
      <p className="flex flex-wrap gap-4 text-sm underline">
        {files?.pdf && <Link href={`/reports/invoices/${d.id}/file?kind=pdf`}>Descargar PDF</Link>}
        {files?.xml && <Link href={`/reports/invoices/${d.id}/file?kind=xml`}>Descargar XML</Link>}
        {ext(d.pdfUrl) && !files?.pdf && <a href={ext(d.pdfUrl)!} rel="noopener noreferrer" target="_blank">PDF del PSE</a>}
        {ext(d.xmlUrl) && !files?.xml && <a href={ext(d.xmlUrl)!} rel="noopener noreferrer" target="_blank">XML del PSE</a>}
        {d.saleId && <Link href={`/cash-register/sales/${d.saleId}`}>Ver venta</Link>}
      </p>
      {d.status !== "ACCEPTED" && (
        <form action={retryDocumentAction} className="space-y-2 rounded-lg border border-border p-3 text-sm">
          <input type="hidden" name="id" value={d.id} /><input type="hidden" name="kind" value={d.kind} />
          <h2 className="font-semibold">{d.status === "REJECTED" ? "Corregir y reenviar" : "Reintentar envío"}</h2>
          {d.kind !== "CREDIT_NOTE" && d.status === "REJECTED" && (
            <div className="flex flex-wrap gap-2">
              <input name="vDoc" placeholder={d.kind === "FACTURA" ? "RUC" : "DNI"} defaultValue={d.customerDocNumber ?? ""} className={input + " w-32"} />
              <input name="vName" placeholder="Nombre / razón social" defaultValue={d.customerName} className={input + " w-56"} />
              <input name="vAddress" placeholder="Dirección" defaultValue={d.customerAddress ?? ""} className={input + " w-56"} />
              <input name="vEmail" placeholder="Correo" defaultValue={d.customerEmail ?? ""} className={input + " w-48"} />
            </div>
          )}
          <Button size="sm">{d.status === "REJECTED" ? "Reenviar con el mismo número" : "Reintentar ahora"}</Button>
        </form>
      )}
      {d.kind !== "CREDIT_NOTE" && d.status === "ACCEPTED" && !d.creditedAt && !nc && (
        <form action={creditNoteAction} className="space-y-2 rounded-lg border border-border p-3 text-sm">
          <input type="hidden" name="id" value={d.id} />
          <h2 className="font-semibold">Anular con nota de crédito (por el total)</h2>
          <div className="flex flex-wrap gap-2">
            <select name="reason" required className={input}>
              {Object.entries(CREDIT_REASON_LABEL).filter(([k]) => k !== "02" || d.kind === "FACTURA").map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <Input name="reasonText" required minLength={3} maxLength={250} placeholder="Motivo detallado" className="w-72" />
            <Button size="sm" variant="destructive">Emitir nota de crédito</Button>
          </div>
          <p className="text-xs text-muted-foreground">La nota de crédito anula el comprobante ante SUNAT. No revierte stock, saldo de cuponera, puntos ni dinero de la caja: eso se gestiona aparte.</p>
        </form>
      )}
    </div>
  );
}
