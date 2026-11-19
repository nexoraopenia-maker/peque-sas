import "server-only";
import { z } from "zod";
import { db } from "@/lib/db";
import { formatSoles } from "@/lib/billing/money";
import { tenantHasModule } from "@/lib/plans/modules";
import { limaDate } from "@/lib/utils/date";
import { checkAvailability, createReservation } from "@/lib/reservations/service";
import { needsSpace, type ReservationService } from "@/lib/reservations/status";
import type { AiTool } from "@/lib/ai/anthropic";
import { describeHours, isOpenNow, parseHours } from "./hours";

/**
 * Herramientas del bot. SEGURIDAD: el tenant, la conversación y el teléfono del cliente salen del servidor (ToolCtx), NUNCA de los
 * argumentos del modelo; así el modelo no puede consultar ni escribir datos de otro establecimiento aunque se le intente inyectar.
 * Solo hay 4 herramientas de lectura y 2 de escritura acotada: registrar una solicitud de reserva PENDIENTE y pasar a una persona.
 * No existe ninguna herramienta que lea datos de menores, saldos, deudas ni asistencia.
 */
export type ToolCtx = { tenantId: string; conversationId: string; waId: string; now: Date };
export type ToolResult = { output: unknown; isError?: boolean; availability?: { available: boolean }; handoff?: string };

const SERVICES = ["LUDOTECA", "CUMPLEANOS", "GUARDERIA", "EVENTO"] as const;
const empty = { type: "object" as const, properties: {}, additionalProperties: false };
const resv = {
  service: { type: "string" as const, enum: [...SERVICES], description: "LUDOTECA, CUMPLEANOS, GUARDERIA o EVENTO" },
  date: { type: "string" as const, description: "Fecha AAAA-MM-DD" },
  startTime: { type: "string" as const, description: "Hora de inicio HH:MM (24 h)" },
  endTime: { type: "string" as const, description: "Hora de fin HH:MM (24 h)" },
  attendees: { type: "integer" as const, description: "Número de asistentes (niños y adultos)" },
};

export const TOOL_DEFS: AiTool[] = [
  { name: "get_business_info", description: "Nombre, horario de atención, si está abierto ahora y políticas del establecimiento.", input_schema: empty, strict: true },
  { name: "get_faqs", description: "Preguntas frecuentes con sus respuestas oficiales.", input_schema: empty, strict: true },
  { name: "get_prices", description: "Precios vigentes: tarifas de ludoteca, paquetes de minutos (cuponeras) y servicios del establecimiento.", input_schema: empty, strict: true },
  { name: "check_availability", description: "Consulta si hay cupo o espacio. No reserva nada. Úsala SIEMPRE antes de hablar de disponibilidad.", input_schema: { type: "object", properties: resv, required: ["service", "date", "startTime", "endTime", "attendees"], additionalProperties: false }, strict: true },
  { name: "request_reservation", description: "Registra una SOLICITUD de reserva que queda PENDIENTE hasta que el equipo la confirme. No confirma nada.", input_schema: { type: "object", properties: { ...resv, contactName: { type: "string", description: "Nombre del contacto" }, packageServiceId: { type: "string", description: "Opcional: id de un servicio/paquete de get_prices" }, notes: { type: "string", description: "Opcional: observaciones del cliente" } }, required: ["service", "date", "startTime", "endTime", "attendees", "contactName"], additionalProperties: false }, strict: true },
  { name: "handoff_to_human", description: "Pasa la conversación a una persona del equipo y detiene al bot. Úsala si no tienes el dato, hay un reclamo o una emergencia, o el cliente lo pide.", input_schema: { type: "object", properties: { reason: { type: "string", description: "Motivo breve" } }, required: ["reason"], additionalProperties: false }, strict: true },
];

const slot = z.object({ service: z.enum(SERVICES), date: z.string(), startTime: z.string(), endTime: z.string(), attendees: z.number().int() });
const reserve = slot.extend({ contactName: z.string().trim().min(2).max(100), packageServiceId: z.string().max(64).optional(), notes: z.string().max(300).optional() });
const handoffArgs = z.object({ reason: z.string().trim().max(200).default("Sin motivo") });
const bad = (msg = "Parámetros inválidos"): ToolResult => ({ output: { error: msg }, isError: true });
const MOTIVO: Record<string, string> = { INVALID: "fecha u hora no válidas", PAST: "la fecha ya pasó", TOO_FAR: "la fecha está demasiado lejos", CLOSED: "no atendemos en ese horario", FULL: "no quedan cupos suficientes en ese horario", NO_SPACE: "no hay un espacio libre para esa cantidad de personas en ese horario" };

async function serviceOffered(tenantId: string, s: ReservationService) {
  const t = await db.tenant.findUnique({ where: { id: tenantId }, select: { modules: true } });
  return s === "GUARDERIA" ? tenantHasModule(t?.modules, "DAYCARE") : tenantHasModule(t?.modules, "PLAYGROUND");
}

export async function runTool(ctx: ToolCtx, name: string, input: unknown): Promise<ToolResult> {
  const { tenantId } = ctx;
  try {
    switch (name) {
      case "get_business_info": {
        const [t, cfg] = await Promise.all([db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }), db.botConfig.findUnique({ where: { tenantId } })]);
        const hours = parseHours(cfg?.hours);
        return { output: { negocio: t?.name, horario: describeHours(hours), abiertoAhora: isOpenNow(hours, ctx.now), politicas: cfg?.policies ?? "El establecimiento no cargó políticas." } };
      }
      case "get_faqs": {
        const faqs = await db.botFaq.findMany({ where: { tenantId, isActive: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], take: 40 });
        return { output: faqs.length ? { preguntas: faqs.map((f) => ({ pregunta: f.question, respuesta: f.answer })) } : { vacio: true, nota: "El establecimiento no cargó preguntas frecuentes." } };
      }
      case "get_prices": {
        const [rates, packages, services] = await Promise.all([
          db.playgroundRate.findMany({ where: { tenantId, isActive: true }, orderBy: { minutes: "asc" } }),
          db.prepaidPackage.findMany({ where: { tenantId, isActive: true }, orderBy: { minutes: "asc" } }),
          db.botService.findMany({ where: { tenantId, isActive: true }, orderBy: { createdAt: "asc" }, take: 40 }),
        ]);
        if (!rates.length && !packages.length && !services.length) return { output: { vacio: true, nota: "El establecimiento aún no cargó precios: no los inventes, usa handoff_to_human." } };
        return { output: {
          tarifasLudoteca: rates.map((r) => ({ nombre: r.name, minutos: r.minutes, precio: formatSoles(r.priceCents), ...(r.extraMinuteCents ? { precioPorMinutoExtra: formatSoles(r.extraMinuteCents) } : {}) })),
          paquetesDeMinutos: packages.map((p) => ({ nombre: p.name, minutos: p.minutes, precio: formatSoles(p.priceCents) })),
          servicios: services.map((s) => ({ id: s.id, nombre: s.name, descripcion: s.description ?? undefined, ...(s.priceCents != null ? { precio: formatSoles(s.priceCents) } : { precio: "consultar" }) })),
        } };
      }
      case "check_availability": {
        const p = slot.safeParse(input);
        if (!p.success) return bad();
        if (!(await serviceOffered(tenantId, p.data.service))) return { output: { disponible: false, motivo: "el establecimiento no ofrece ese servicio" }, availability: { available: false } };
        const a = await checkAvailability({ tenantId, serviceType: p.data.service, date: p.data.date, startTime: p.data.startTime, endTime: p.data.endTime, attendees: p.data.attendees });
        return { output: { disponible: a.available, ...(a.reason ? { motivo: MOTIVO[a.reason] } : {}), ...(a.spaces ? { espaciosLibres: a.spaces.map((s) => ({ nombre: s.name, capacidad: s.capacity })) } : {}), ...(a.remaining !== undefined && !a.spaces ? { cuposRestantes: a.remaining } : {}) }, availability: { available: a.available } };
      }
      case "request_reservation": {
        const p = reserve.safeParse(input);
        if (!p.success) return bad();
        if (!(await serviceOffered(tenantId, p.data.service))) return { output: { registrada: false, motivo: "el establecimiento no ofrece ese servicio" } };
        // Límite anti-abuso: 2 solicitudes por conversación y día
        const mine = `bot:${ctx.conversationId}`;
        const startOfDay = new Date(`${limaDate(ctx.now)}T00:00:00-05:00`);
        if ((await db.reservation.count({ where: { tenantId, createdById: mine, createdAt: { gte: startOfDay } } })) >= 2) return { output: { registrada: false, motivo: "ya se registraron solicitudes hoy; una persona del equipo debe continuar" }, handoff: "Límite diario de solicitudes de reserva del bot" };
        const a = await checkAvailability({ tenantId, serviceType: p.data.service, date: p.data.date, startTime: p.data.startTime, endTime: p.data.endTime, attendees: p.data.attendees });
        if (!a.available) return { output: { registrada: false, motivo: MOTIVO[a.reason ?? "FULL"] }, availability: { available: false } };
        const pkg = p.data.packageServiceId ? await db.botService.findFirst({ where: { id: p.data.packageServiceId, tenantId, isActive: true } }) : null;
        try {
          const id = await createReservation({
            tenantId, userId: mine, serviceType: p.data.service, childId: null, spaceId: needsSpace(p.data.service) ? a.spaces?.[0]?.id ?? null : null,
            contactName: p.data.contactName, contactPhone: ctx.waId, date: p.data.date, startTime: p.data.startTime, endTime: p.data.endTime, attendees: p.data.attendees,
            packageName: pkg?.name, notes: p.data.notes ? `Solicitud por WhatsApp (bot). ${p.data.notes}` : "Solicitud por WhatsApp (bot).", totalAmountCents: pkg?.priceCents ?? 0, advanceRequiredCents: 0,
          });
          await db.conversationNote.create({ data: { tenantId, conversationId: ctx.conversationId, authorId: "bot", body: `El bot registró una SOLICITUD de reserva PENDIENTE (${p.data.service} ${p.data.date} ${p.data.startTime}-${p.data.endTime}, ${p.data.attendees} personas, ref. ${id.slice(0, 8)}). Requiere confirmación del equipo.` } });
          return { output: { registrada: true, estado: "PENDIENTE_DE_CONFIRMACION", referencia: id.slice(0, 8), aviso: "El equipo debe confirmar la solicitud. NO digas que está confirmada." }, availability: { available: true } };
        } catch {
          // No se revela el motivo interno (puede incluir razones del personal); el cupo pudo ocuparse entre la consulta y el registro
          return { output: { registrada: false, motivo: "ya no hay disponibilidad en ese horario" }, availability: { available: false } };
        }
      }
      case "handoff_to_human": {
        const p = handoffArgs.safeParse(input);
        return { output: { ok: true, nota: "Una persona continuará la conversación." }, handoff: p.success ? p.data.reason : "Sin motivo" };
      }
      default:
        return { output: { error: "Herramienta desconocida" }, isError: true };
    }
  } catch {
    return { output: { error: "No se pudo obtener la información" }, isError: true };
  }
}
