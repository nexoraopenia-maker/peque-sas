import Link from "next/link";
import { requirePermission, requireFeature } from "@/lib/rbac";
import { db } from "@/lib/db";
import { tenantDb } from "@/lib/db/tenant";
import { limaDate } from "@/lib/utils/date";
import { formatSoles } from "@/lib/billing/money";
import { parseHours } from "@/lib/whatsapp/bot/hours";
import { DEFAULT_HANDOFF } from "@/lib/whatsapp/bot/handoff";
import { AI_MODEL } from "@/lib/ai/anthropic";
import { addFaqAction, addServiceAction, deleteFaqAction, deleteServiceAction, saveBotConfigAction } from "@/actions/bot";
import { ErrorBanner, OkBanner } from "@/components/dashboard/banner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";
const DAYS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
const area = "w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm";

export default async function BotSettingsPage({ searchParams }: { searchParams: Promise<{ e?: string; ok?: string }> }) {
  const { tenantId } = await requirePermission("whatsapp:configure");
  await requireFeature("WHATSAPP");
  const q = await searchParams;
  const tdb = tenantDb(tenantId);
  const month = limaDate().slice(0, 7);
  const [cfg, wa, tenant, faqs, services, usage, tokens] = await Promise.all([
    db.botConfig.findUnique({ where: { tenantId } }),
    db.whatsAppConfig.findUnique({ where: { tenantId }, select: { enabled: true } }),
    db.tenant.findUniqueOrThrow({ where: { id: tenantId }, include: { plan: { select: { automationsEnabled: true, botMonthlyReplies: true } } } }),
    tdb.botFaq.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
    tdb.botService.findMany({ orderBy: { createdAt: "asc" } }),
    db.botUsage.count({ where: { tenantId, month } }),
    db.botUsage.aggregate({ where: { tenantId, month }, _sum: { inputTokens: true, outputTokens: true } }),
  ]);
  const hours = parseHours(cfg?.hours);
  const day = (d: number) => hours.find((h) => h.day === d);
  const aiKey = !!process.env.ANTHROPIC_API_KEY;
  const warns = [
    !aiKey && "El sistema no tiene configurada la clave de IA (la administra el SuperAdmin): el bot pasará todas las conversaciones a una persona.",
    !tenant.plan.automationsEnabled && "Tu plan actual no incluye automatizaciones: el bot no responderá hasta cambiar de plan.",
    !wa?.enabled && "WhatsApp no está activo en este establecimiento (Configuración → WhatsApp).",
  ].filter(Boolean) as string[];
  const [rates, packs] = await Promise.all([tdb.playgroundRate.count({ where: { isActive: true } }), tdb.prepaidPackage.count({ where: { isActive: true } })]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between"><h1 className="text-2xl font-bold">Chatbot de WhatsApp</h1><Link href="/settings/whatsapp" className="underline">← WhatsApp</Link></div>
      <ErrorBanner message={q.e} /><OkBanner message={q.ok} />
      {warns.map((w) => <p key={w} className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-300">{w}</p>)}

      <section className="space-y-1 rounded-lg border border-border p-4 text-sm">
        <h2 className="font-semibold">Cómo funciona</h2>
        <p className="text-muted-foreground">El bot responde <b>solo</b> con datos reales de tu establecimiento: precios, horarios, preguntas frecuentes y disponibilidad. Si no tiene el dato, pasa la conversación a una persona. <b>Nunca confirma reservas</b>: solo registra solicitudes pendientes que tu equipo confirma. Antes de enviar cada respuesta se verifica que los importes, la disponibilidad y los enlaces provengan de tus datos; si algo no cuadra, la conversación pasa a una persona. Cuando alguien del equipo toma un chat, el bot se detiene en ese chat.</p>
        <p>Consumo de IA este mes: <b>{usage}</b> de <b>{tenant.plan.botMonthlyReplies}</b> respuestas incluidas en tu plan · {(tokens._sum.inputTokens ?? 0) + (tokens._sum.outputTokens ?? 0)} tokens · modelo {AI_MODEL()}. Al alcanzar el límite, las conversaciones pasan a una persona.</p>
        <p className="text-muted-foreground">Precios leídos automáticamente: {rates} tarifas de ludoteca y {packs} paquetes de minutos (se administran en Ludoteca), más los servicios de abajo.</p>
      </section>

      <form action={saveBotConfigAction} className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-2">
        <h2 className="font-semibold sm:col-span-2">Configuración</h2>
        <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="enabled" defaultChecked={cfg?.enabled} className="size-5" /> <b>Bot activo</b> (si se desactiva, ninguna conversación recibe respuestas automáticas)</label>
        <label className="block text-sm sm:col-span-2">Personalidad y tono<Input name="personality" defaultValue={cfg?.personality ?? "Amable, cercano y breve"} maxLength={200} /></label>
        <label className="block text-sm sm:col-span-2">Instrucciones adicionales (no pueden cambiar las reglas de seguridad)<textarea name="instructions" defaultValue={cfg?.instructions ?? ""} maxLength={2000} rows={3} className={area} placeholder="Ej.: Menciona que tenemos estacionamiento gratuito." /></label>
        <label className="block text-sm sm:col-span-2">Políticas (cancelaciones, adelantos, normas; el bot las cita tal cual)<textarea name="policies" defaultValue={cfg?.policies ?? ""} maxLength={2000} rows={3} className={area} /></label>
        <label className="block text-sm">Mensaje de bienvenida (primer contacto)<textarea name="welcomeMessage" defaultValue={cfg?.welcomeMessage ?? ""} maxLength={500} rows={2} className={area} /></label>
        <label className="block text-sm">Mensaje fuera de horario (una vez por día)<textarea name="outOfHoursMessage" defaultValue={cfg?.outOfHoursMessage ?? ""} maxLength={500} rows={2} className={area} placeholder="Si lo dejas vacío se usa un mensaje estándar." /></label>
        <label className="block text-sm sm:col-span-2">Mensaje al pasar a una persona<textarea name="handoffMessage" defaultValue={cfg?.handoffMessage ?? DEFAULT_HANDOFF} maxLength={500} rows={2} className={area} /></label>
        <fieldset className="sm:col-span-2">
          <legend className="text-sm">Horario de atención (hora de Lima). Deja vacío un día para marcarlo cerrado; sin ningún horario, el bot atiende siempre.</legend>
          <div className="mt-2 grid gap-1 sm:grid-cols-2">
            {DAYS.map((n, d) => (
              <div key={d} className="flex items-center gap-2 text-sm"><span className="w-24">{n}</span>
                <input type="time" name={`open_${d}`} defaultValue={day(d)?.open ?? ""} className="h-8 rounded-md border border-input bg-background px-2" aria-label={`${n} apertura`} />
                <span>a</span><input type="time" name={`close_${d}`} defaultValue={day(d)?.close ?? ""} className="h-8 rounded-md border border-input bg-background px-2" aria-label={`${n} cierre`} /></div>
            ))}
          </div>
        </fieldset>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="answerOutsideHours" defaultChecked={cfg?.answerOutsideHours} className="size-4" /> Responder también fuera de horario</label>
        <label className="block text-sm">Máximo de respuestas del bot por conversación y hora<Input name="maxRepliesPerHour" type="number" min="1" max="100" defaultValue={cfg?.maxRepliesPerHour ?? 20} /></label>
        <Button className="sm:col-span-2">Guardar configuración</Button>
      </form>

      <section className="space-y-2">
        <h2 className="font-semibold">Preguntas frecuentes</h2>
        <form action={addFaqAction} className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_1fr_auto]">
          <Input name="question" placeholder="Pregunta" required maxLength={300} /><Input name="answer" placeholder="Respuesta oficial" required maxLength={1000} /><Button size="sm">Agregar</Button>
        </form>
        <ul className="divide-y divide-border rounded-lg border border-border text-sm">
          {faqs.map((f) => <li key={f.id} className="flex items-start justify-between gap-2 p-2"><span><b>{f.question}</b><br />{f.answer}</span>
            <form action={deleteFaqAction}><input type="hidden" name="id" value={f.id} /><button className="text-xs underline">Quitar</button></form></li>)}
          {faqs.length === 0 && <li className="p-2 text-muted-foreground">Sin preguntas frecuentes: el bot no podrá responder sobre esos temas y pasará la conversación a una persona.</li>}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">Servicios y precios adicionales (cumpleaños, eventos…)</h2>
        <form action={addServiceAction} className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_1.5fr_8rem_auto]">
          <Input name="name" placeholder="Nombre" required maxLength={100} /><Input name="description" placeholder="Descripción" maxLength={300} /><Input name="price" placeholder="Precio S/ (opcional)" inputMode="decimal" /><Button size="sm">Agregar</Button>
        </form>
        <ul className="divide-y divide-border rounded-lg border border-border text-sm">
          {services.map((s) => <li key={s.id} className="flex items-start justify-between gap-2 p-2"><span><b>{s.name}</b> · {s.priceCents != null ? formatSoles(s.priceCents) : "consultar"}{s.description ? <><br />{s.description}</> : null}</span>
            <form action={deleteServiceAction}><input type="hidden" name="id" value={s.id} /><button className="text-xs underline">Quitar</button></form></li>)}
          {services.length === 0 && <li className="p-2 text-muted-foreground">Sin servicios adicionales.</li>}
        </ul>
      </section>
    </div>
  );
}
