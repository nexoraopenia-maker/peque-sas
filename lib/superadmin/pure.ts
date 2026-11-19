import { z } from "zod";
// Lógica pura del panel SuperAdmin (sin BD): validación de formularios y catálogo de datos FICTICIOS para demos.

export const MODULE_KEYS = ["PLAYGROUND", "DAYCARE", "WHATSAPP", "SUNAT"] as const;
export const MODULE_LABEL: Record<(typeof MODULE_KEYS)[number], string> = { PLAYGROUND: "Ludoteca", DAYCARE: "Guardería", WHATSAPP: "WhatsApp", SUNAT: "Facturación SUNAT" };
export const BUSINESS_TYPES = ["ludoteca", "guarderia", "ludoteca_guarderia", "otro"] as const;
export const MAX_DEMO_DAYS = 90;
export const MIN_PASSWORD = 12;

const limaDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
/** Vence al terminar el día indicado (hora de Lima, UTC-5). */
export const endOfLimaDay = (day: string) => new Date(`${day}T23:59:59.999-05:00`);

export const demoSchema = z.object({
  name: z.string().trim().min(3).max(80),
  businessType: z.enum(BUSINESS_TYPES),
  adminEmail: z.string().trim().toLowerCase().pipe(z.email()),
  adminName: z.string().trim().min(2).max(80),
  // Vacío = se genera una contraseña segura
  password: z.string().max(100).optional().transform((v) => (v ? v : undefined)).refine((v) => v === undefined || v.length >= MIN_PASSWORD, { message: `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres` }),
  modules: z.array(z.enum(MODULE_KEYS)).min(1, "Elige al menos un módulo"),
  expiresAt: z.iso.date(),
  maxUsers: z.coerce.number().int().min(3).max(20).default(5),
  storageMb: z.coerce.number().int().min(50).max(5000).default(200),
  botMonthlyReplies: z.coerce.number().int().min(0).max(5000).default(300),
  whatsappEnabled: z.boolean().default(false),
  automationsEnabled: z.boolean().default(false),
});
export type DemoInput = z.infer<typeof demoSchema>;

/** Fecha de vencimiento: futura (desde mañana) y a lo sumo MAX_DEMO_DAYS días. */
export function checkExpiry(day: string, now = new Date()): string | null {
  const end = endOfLimaDay(day);
  if (isNaN(end.getTime())) return "Fecha de vencimiento inválida";
  if (limaDay(end) !== day) return "Fecha de vencimiento inválida";
  if (end <= now) return "El vencimiento debe ser una fecha futura";
  if (end.getTime() - now.getTime() > MAX_DEMO_DAYS * 86_400_000) return `El vencimiento no puede superar ${MAX_DEMO_DAYS} días`;
  return null;
}

export const planSchema = z.object({
  name: z.string().trim().min(2).max(60),
  modules: z.array(z.enum(MODULE_KEYS)),
  maxUsers: z.coerce.number().int().min(1).max(500),
  storageMb: z.coerce.number().int().min(10).max(1_000_000),
  botMonthlyReplies: z.coerce.number().int().min(0).max(1_000_000),
  // Precio mensual en SOLES (se guarda en céntimos). 0 = plan gratuito (sin cobro).
  price: z.coerce.number().min(0).max(1_000_000).transform((v) => Math.round(v * 100)).default(0),
  billingPeriodDays: z.coerce.number().int().min(1).max(366).default(30),
  automationsEnabled: z.boolean().default(false),
  reportsEnabled: z.boolean().default(true),
}).transform(({ price, ...r }) => ({ ...r, priceCents: price }));

// ---------- Datos FICTICIOS para demos (nunca datos reales) ----------
export const DEMO_FAMILIES = [
  { guardian: "Lucía Ramos (demo)", child: "Mateo Ramos (demo)", birth: "2021-03-14", allergy: "Alergia leve al maní" },
  { guardian: "Carlos Quispe (demo)", child: "Valentina Quispe (demo)", birth: "2020-07-02", allergy: null },
  { guardian: "Rosa Huamán (demo)", child: "Thiago Huamán (demo)", birth: "2022-01-20", allergy: null },
  { guardian: "Jorge Castillo (demo)", child: "Camila Castillo (demo)", birth: "2019-11-05", allergy: "Intolerancia a la lactosa" },
  { guardian: "Patricia Flores (demo)", child: "Sebastián Flores (demo)", birth: "2021-09-30", allergy: null },
  { guardian: "Miguel Torres (demo)", child: "Isabella Torres (demo)", birth: "2020-04-18", allergy: null },
  { guardian: "Ana Mendoza (demo)", child: "Daniel Mendoza (demo)", birth: "2022-06-09", allergy: null },
  { guardian: "Luis Vargas (demo)", child: "Emma Vargas (demo)", birth: "2019-12-25", allergy: null },
] as const;
/** Teléfonos y DNI claramente ficticios (rango 900 000 0xx / 0000 00xx). */
export const demoPhone = (i: number) => `9000000${String(i + 1).padStart(2, "0")}`;
export const demoDni = (i: number) => `0000${String(i + 1).padStart(4, "0")}`;

export const DEMO_PRODUCTS = [
  { name: "Gaseosa 500 ml", sku: "BEB-001", priceCents: 350, stock: 60, minStock: 10 },
  { name: "Agua mineral 625 ml", sku: "BEB-002", priceCents: 200, stock: 80, minStock: 15 },
  { name: "Jugo de naranja", sku: "BEB-003", priceCents: 400, stock: 40, minStock: 8 },
  { name: "Galletas surtidas", sku: "SNK-001", priceCents: 150, stock: 100, minStock: 20 },
  { name: "Papas fritas", sku: "SNK-002", priceCents: 250, stock: 70, minStock: 12 },
  { name: "Chocolate pequeño", sku: "SNK-003", priceCents: 180, stock: 90, minStock: 15 },
  { name: "Calcetines antideslizantes", sku: "ACC-001", priceCents: 800, stock: 30, minStock: 5 },
  { name: "Bolsa sorpresa de cumpleaños", sku: "CUM-001", priceCents: 1200, stock: 25, minStock: 5 },
] as const;
export const DEMO_RATES = [
  { name: "30 minutos", minutes: 30, priceCents: 1000, extraMinuteCents: 40 },
  { name: "1 hora", minutes: 60, priceCents: 1800, extraMinuteCents: 35 },
  { name: "2 horas", minutes: 120, priceCents: 3000, extraMinuteCents: 30 },
] as const;
export const DEMO_PACKAGES = [
  { name: "Cuponera 300", minutes: 300, priceCents: 12000 },
  { name: "Cuponera 600", minutes: 600, priceCents: 21000 },
  { name: "Cuponera 1200", minutes: 1200, priceCents: 38000 },
] as const;
export const DEMO_SPACES = [{ name: "Sala de cumpleaños (demo)", capacity: 25 }, { name: "Salón de eventos (demo)", capacity: 50 }] as const;
/** Empleados de la demo: se crean tantos como permita el límite de usuarios (el administrador ya cuenta). */
export const DEMO_EMPLOYEES = [
  { role: "RECEPTION", name: "Recepción Demo" }, { role: "TEACHER", name: "Profesora Demo" }, { role: "ADMIN", name: "Administración Demo" },
] as const;
export const DEMO_FEE_CENTS = 45_000;
