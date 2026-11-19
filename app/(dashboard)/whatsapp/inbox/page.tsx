import Link from "next/link";
import { requirePermission, requireFeature } from "@/lib/rbac";
import { hasPermission } from "@/lib/rbac/permissions";
import { db } from "@/lib/db";
import { tenantDb } from "@/lib/db/tenant";
import { inServiceWindow } from "@/lib/whatsapp/phone";
import { customerPanel, markSeen } from "@/lib/whatsapp/inbox";
import { formatSoles } from "@/lib/billing/money";
import { SERVICE_LABEL, STATUS_LABEL } from "@/lib/reservations/status";
import { addNoteAction, conversationAction, sendFileAction, sendTextAction } from "@/actions/inbox";
import { AutoRefresh } from "@/components/dashboard/auto-refresh";
import { ErrorBanner } from "@/components/dashboard/banner";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";
const FILTERS = { open: "Abiertas", attention: "Necesitan atención", mine: "Mías", unassigned: "Sin asignar", closed: "Cerradas" } as const;
type Filter = keyof typeof FILTERS;
const tm = (d: Date) => d.toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short", timeZone: "America/Lima" });
const TICK = { PENDING: "⏳", SENT: "✓", DELIVERED: "✓✓", READ: "✓✓ leído", FAILED: "⚠ falló", RECEIVED: "" } as const;
const preview = (m?: { type: string; body: string | null }) => (!m ? "—" : m.body ? m.body.slice(0, 60) : `[${m.type.toLowerCase()}]`);
const MEDIA = new Set(["IMAGE", "DOCUMENT", "AUDIO", "VIDEO", "STICKER"]);

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ c?: string; f?: string; e?: string }> }) {
  const { user, tenantId } = await requirePermission("whatsapp:use");
  await requireFeature("WHATSAPP");
  const q = await searchParams;
  const filter: Filter = q.f && q.f in FILTERS ? (q.f as Filter) : "open";
  const tdb = tenantDb(tenantId);
  const configured = !!(await db.whatsAppConfig.findUnique({ where: { tenantId }, select: { id: true } }));

  const where = {
    open: { status: "OPEN" }, attention: { status: "OPEN", needsHuman: true }, mine: { status: "OPEN", assignedToId: user.id },
    unassigned: { status: "OPEN", assignedToId: null }, closed: { status: "CLOSED" },
  }[filter] as Record<string, unknown>;
  const [list, users, counts] = await Promise.all([
    tdb.whatsAppConversation.findMany({ where, orderBy: [{ needsHuman: "desc" }, { lastMessageAt: "desc" }], take: 100, include: { messages: { orderBy: { createdAt: "desc" }, take: 1, select: { type: true, body: true, direction: true } } } }),
    db.user.findMany({ where: { tenantId, isActive: true }, select: { id: true, name: true, role: true } }),
    tdb.whatsAppConversation.count({ where: { status: "OPEN", needsHuman: true } }),
  ]);
  const name = new Map(users.map((u) => [u.id, u.name]));
  const staff = users.filter((u) => hasPermission(u.role, "whatsapp:use"));

  const selected = q.c ? await tdb.whatsAppConversation.findFirst({ where: { id: q.c } }) : null;
  const [messages, notes, panel] = selected
    ? await Promise.all([
        tdb.whatsAppMessage.findMany({ where: { conversationId: selected.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 150 }),
        tdb.conversationNote.findMany({ where: { conversationId: selected.id }, orderBy: { createdAt: "desc" }, take: 50 }),
        customerPanel(tenantId, selected.waId),
      ])
    : [[], [], null];
  if (selected) await markSeen(tenantId, selected.id);
  const timeline = [
    ...messages.map((m) => ({ at: m.createdAt, kind: "msg" as const, m })),
    ...notes.map((n) => ({ at: n.createdAt, kind: "note" as const, n })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
  const open = selected ? inServiceWindow(selected.lastInboundAt) : false;
  const hidden = (n: string, v: string) => <input type="hidden" name={n} value={v} />;
  const op = (label: string, o: string, variant: "outline" | "destructive" | "default" = "outline") => (
    <form action={conversationAction}>{hidden("c", selected!.id)}{hidden("f", filter)}{hidden("op", o)}<Button size="sm" variant={variant}>{label}</Button></form>
  );

  if (!configured) return <div className="space-y-2"><h1 className="text-2xl font-bold">Bandeja de WhatsApp</h1><p className="text-sm text-muted-foreground">WhatsApp aún no está configurado. <Link href="/settings/whatsapp" className="underline">Configurar</Link></p></div>;

  return (
    <div className="space-y-3">
      <AutoRefresh seconds={20} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Bandeja de WhatsApp {counts > 0 && <span className="ml-2 rounded-full bg-red-500/20 px-2 py-0.5 text-sm text-red-300">{counts} por atender</span>}</h1>
        {hasPermission(user.role, "whatsapp:configure") && <Link href="/settings/whatsapp/bot" className="text-sm underline">Configurar el bot</Link>}
      </div>
      <ErrorBanner message={q.e} />
      <div className="grid gap-3 lg:grid-cols-[300px_minmax(0,1fr)_300px]">
        {/* Panel 1: conversaciones */}
        <aside className="space-y-2 lg:max-h-[75vh] lg:overflow-y-auto">
          <nav className="flex flex-wrap gap-1 text-xs">
            {(Object.keys(FILTERS) as Filter[]).map((f) => <Link key={f} href={`/whatsapp/inbox?f=${f}`} className={`rounded-md border px-2 py-1 ${f === filter ? "border-primary bg-accent" : "border-border"}`}>{FILTERS[f]}</Link>)}
          </nav>
          <ul className="divide-y divide-border rounded-lg border border-border text-sm">
            {list.map((c) => {
              const unread = c.lastInboundAt && (!c.staffSeenAt || c.staffSeenAt < c.lastInboundAt);
              return (
                <li key={c.id} className={c.id === selected?.id ? "bg-accent/50" : ""}>
                  <Link href={`/whatsapp/inbox?c=${c.id}&f=${filter}`} className="block space-y-0.5 p-2">
                    <span className="flex items-center justify-between gap-2"><b className={unread ? "" : "font-medium"}>{c.contactName ?? `…${c.waId.slice(-4)}`}</b><span className="text-xs text-muted-foreground">{tm(c.lastMessageAt)}</span></span>
                    <span className="block truncate text-muted-foreground">{c.messages[0]?.direction === "OUT" ? "Tú: " : ""}{preview(c.messages[0])}</span>
                    <span className="flex flex-wrap gap-1 text-xs">
                      {c.needsHuman && <span className="rounded bg-red-500/20 px-1 text-red-300">Necesita atención</span>}
                      <span className={`rounded px-1 ${c.botEnabled ? "bg-green-500/20 text-green-300" : "bg-zinc-500/20 text-zinc-300"}`}>Bot {c.botEnabled ? "ON" : "OFF"}</span>
                      {c.assignedToId && <span className="rounded bg-sky-500/20 px-1 text-sky-300">👤 {name.get(c.assignedToId) ?? "—"}</span>}
                      {unread && <span className="rounded bg-amber-500/20 px-1 text-amber-300">Nuevo</span>}
                    </span>
                  </Link>
                </li>
              );
            })}
            {list.length === 0 && <li className="p-3 text-muted-foreground">No hay conversaciones en esta vista.</li>}
          </ul>
        </aside>

        {/* Panel 2: conversación */}
        <section className="min-w-0 space-y-2">
          {!selected ? <p className="rounded-lg border border-border p-6 text-sm text-muted-foreground">Selecciona una conversación.</p> : (
            <>
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2 text-sm">
                <b>{selected.contactName ?? `…${selected.waId.slice(-4)}`}</b>
                <span className="text-muted-foreground">Bot {selected.botEnabled ? "ON" : "OFF"}{selected.assignedToId ? ` · asignada a ${name.get(selected.assignedToId) ?? "—"}` : ""}{selected.status === "CLOSED" ? " · cerrada" : ""}</span>
                {selected.needsHuman && <span className="rounded bg-red-500/20 px-1 text-red-300">Necesita atención{selected.handoffReason ? `: ${selected.handoffReason}` : ""}</span>}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {selected.assignedToId !== user.id && op("Tomar conversación", "claim", "default")}
                {selected.botEnabled ? op("Apagar bot", "bot_off") : op("Devolver al bot", "release")}
                {selected.status === "OPEN" ? op("Cerrar", "close") : op("Reabrir", "reopen")}
                <form action={conversationAction} className="flex items-center gap-1">
                  {hidden("c", selected.id)}{hidden("f", filter)}{hidden("op", "assign")}
                  <select name="assignee" defaultValue={selected.assignedToId ?? ""} className="h-8 rounded-md border border-input bg-background px-2 text-sm" aria-label="Asignar a">
                    <option value="">Sin asignar</option>{staff.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                  <Button size="sm" variant="outline">Asignar</Button>
                </form>
              </div>

              <ul className="max-h-[48vh] space-y-2 overflow-y-auto rounded-lg border border-border p-3 text-sm">
                {timeline.length === 0 && <li className="text-muted-foreground">Sin mensajes.</li>}
                {timeline.map((e) => e.kind === "note" ? (
                  <li key={`n${e.n.id}`} className="rounded-md border border-dashed border-amber-500/50 bg-amber-500/10 p-2">
                    <span className="text-xs text-amber-300">📝 Nota interna (no se envía) · {e.n.authorId === "bot" ? "Bot" : name.get(e.n.authorId) ?? "—"} · {tm(e.n.createdAt)}</span><br />{e.n.body}
                  </li>
                ) : (
                  <li key={e.m.id} className={`max-w-[85%] rounded-lg p-2 ${e.m.direction === "IN" ? "bg-muted" : "ml-auto bg-primary/20"}`}>
                    <span className="block text-xs text-muted-foreground">
                      {e.m.direction === "IN" ? (selected.contactName ?? "Cliente") : e.m.authorKind === "BOT" ? "🤖 Bot" : e.m.authorKind === "AGENT" ? `👤 ${e.m.sentById ? name.get(e.m.sentById) ?? "Equipo" : "Equipo"}` : "⚙ Sistema"}
                      {" · "}{tm(e.m.createdAt)}{e.m.direction === "OUT" ? ` · ${TICK[e.m.status]}` : ""}
                    </span>
                    {MEDIA.has(e.m.type) && e.m.mediaId && (e.m.type === "IMAGE"
                      // eslint-disable-next-line @next/next/no-img-element
                      ? <img src={`/whatsapp/inbox/media/${e.m.id}`} alt="Imagen recibida" className="my-1 max-h-48 rounded" />
                      : <a href={`/whatsapp/inbox/media/${e.m.id}`} className="my-1 block underline">📎 {e.m.mediaFilename ?? e.m.type.toLowerCase()}</a>)}
                    {e.m.type === "TEMPLATE" ? <span className="text-muted-foreground">[Plantilla {e.m.templateName}]</span> : e.m.body ? <span className="whitespace-pre-wrap">{e.m.body}</span> : null}
                    {e.m.status === "FAILED" && <span className="block text-xs text-red-400">{e.m.errorDetail ?? "No se pudo enviar"}</span>}
                  </li>
                ))}
              </ul>

              {open ? (
                <form action={sendTextAction} className="flex gap-2">
                  {hidden("c", selected.id)}{hidden("f", filter)}
                  <textarea name="text" required maxLength={4096} rows={2} placeholder="Escribe un mensaje (al enviar, el bot se apaga en este chat)" className="min-h-12 flex-1 rounded-md border border-input bg-transparent px-3 py-2 text-sm" />
                  <Button>Enviar</Button>
                </form>
              ) : <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm text-amber-300">Pasaron más de 24 h desde el último mensaje del cliente: WhatsApp solo permite enviar plantillas aprobadas. Cuando el cliente escriba, podrás responder.</p>}
              {open && (
                <form action={sendFileAction} encType="multipart/form-data" className="flex flex-wrap items-center gap-2 text-sm">
                  {hidden("c", selected.id)}{hidden("f", filter)}
                  <input type="file" name="file" required accept="image/jpeg,image/png,application/pdf,audio/mpeg,audio/ogg,video/mp4" />
                  <input name="caption" maxLength={1000} placeholder="Texto (opcional)" className="h-8 min-w-40 flex-1 rounded-md border border-input bg-transparent px-2" />
                  <Button size="sm" variant="outline">Enviar archivo</Button>
                </form>
              )}
              <form action={addNoteAction} className="flex gap-2">
                {hidden("c", selected.id)}{hidden("f", filter)}
                <input name="body" required minLength={2} maxLength={2000} placeholder="Nota interna para el equipo (el cliente NO la ve)" className="h-9 flex-1 rounded-md border border-dashed border-amber-500/50 bg-transparent px-3 text-sm" />
                <Button size="sm" variant="outline">Guardar nota</Button>
              </form>
            </>
          )}
        </section>

        {/* Panel 3: cliente */}
        <aside className="space-y-2 text-sm lg:max-h-[75vh] lg:overflow-y-auto">
          {selected && panel ? (
            <>
              <section className="space-y-1 rounded-lg border border-border p-3">
                <h2 className="font-semibold">Cliente</h2>
                <p>WhatsApp: +{selected.waId}</p>
                <p>Ventana de 24 h: {open ? "abierta" : "cerrada"}</p>
                {panel.guardians.length === 0 && <p className="text-muted-foreground">Este número no coincide con ningún apoderado registrado.</p>}
                {panel.guardians.map((g) => <p key={g.id}>👤 {g.fullName}{g.dni ? ` · DNI ${g.dni}` : ""}</p>)}
              </section>
              {panel.children.map((c) => {
                const en = panel.enrollments.find((e) => e.childId === c.id);
                const over = panel.overdue.filter((i) => i.childId === c.id);
                return (
                  <section key={c.id} className="space-y-0.5 rounded-lg border border-border p-3">
                    <h3 className="font-semibold">{c.fullName}</h3>
                    {(c.allergies || c.medicalAlerts) && <p className="text-amber-400">⚠ {[c.allergies, c.medicalAlerts].filter(Boolean).join(" · ")}</p>}
                    <p>Guardería: {en ? `matriculado (${en.entryTime}–${en.exitTime})` : "sin matrícula activa"}</p>
                    <p>Cuponera: {c.prepaidMinutes} min</p>
                    <p className={over.length ? "text-red-400" : ""}>Deuda vencida: {over.length ? formatSoles(over.reduce((n, i) => n + i.amountCents, 0)) : "ninguna"}</p>
                  </section>
                );
              })}
              <section className="space-y-0.5 rounded-lg border border-border p-3">
                <h3 className="font-semibold">Próximas reservas</h3>
                {panel.reservations.map((r) => <p key={r.id}><Link href={`/reservations/${r.id}`} className="underline">{r.date} {r.startTime}</Link> · {SERVICE_LABEL[r.serviceType]} · {STATUS_LABEL[r.status]}</p>)}
                {panel.reservations.length === 0 && <p className="text-muted-foreground">Sin reservas próximas.</p>}
              </section>
            </>
          ) : <p className="rounded-lg border border-border p-3 text-muted-foreground">La información del cliente aparece al abrir una conversación.</p>}
        </aside>
      </div>
    </div>
  );
}
