import { z } from "zod";

const text = (max = 120) => z.string().trim().min(1).max(max);
const optional = (max = 200) => z.string().trim().max(max).optional().transform((v) => (v ? v : undefined));

export const familySchema = z.object({
  guardianName: text(),
  guardianDni: optional(12),
  guardianPhone: optional(20),
  guardianEmail: z.union([z.literal(""), z.email()]).optional().transform((v) => (v ? v.toLowerCase() : undefined)),
  childName: text(),
  childBirthDate: z.union([z.literal(""), z.iso.date()]).optional().transform((v) => (v ? new Date(v) : undefined)),
  allergies: optional(500),
  medicalAlerts: optional(500),
  relationship: optional(40),
});

export const workerSchema = z.object({
  name: text(),
  email: z.string().trim().toLowerCase().pipe(z.email()),
  role: z.enum(["ADMIN", "RECEPTION", "TEACHER"]),
});

export const productSchema = z.object({
  name: text(),
  sku: optional(40),
  unit: text(20).default("unidad"),
  // Precio en soles con 2 decimales; se guarda en céntimos (entero) para evitar errores de coma flotante
  priceCents: z.coerce.number().min(0).max(100000).transform((v) => Math.round(v * 100)),
  minStock: z.coerce.number().int().min(0).max(1000000),
});

export const movementSchema = z.object({
  productId: z.string().min(1),
  type: z.enum(["IN", "OUT", "ADJUST"]),
  quantity: z.coerce.number().int().min(0).max(1000000),
  reason: optional(200),
});

export const changePasswordSchema = z
  .object({ current: z.string().min(1), next: z.string().min(10).max(100), confirm: z.string() })
  .refine((v) => v.next === v.confirm, { message: "Las contraseñas no coinciden", path: ["confirm"] });

export const rateSchema = z.object({
  name: text(60),
  minutes: z.coerce.number().int().min(5).max(1440),
  priceCents: z.coerce.number().min(0).max(100000).transform((v) => Math.round(v * 100)),
  extraMinuteCents: z.coerce.number().min(0).max(1000).transform((v) => Math.round(v * 100)),
});

export const checkInSchema = z.object({
  childId: z.string().min(1),
  rateId: z.string().min(1),
  braceletCode: z.string().trim().min(1).max(20).toUpperCase(),
});

export const checkOutSchema = z.object({
  sessionId: z.string().min(1),
  pickup: z.string().regex(/^[GA]:[\w-]{1,64}$/),
});

export const authorizedPickupSchema = z.object({
  childId: z.string().min(1),
  fullName: text(),
  dni: optional(12),
  phone: optional(20),
  relationship: optional(40),
});

export const incidentSchema = z.object({
  childId: z.string().min(1),
  sessionId: z.string().optional().transform((v) => (v ? v : undefined)),
  type: z.enum(["FALL", "ALLERGY", "BEHAVIOR", "HEALTH", "OTHER"]),
  description: z.string().trim().min(3).max(1000),
});

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const isoDate = z.iso.date();

export const enrollmentSchema = z.object({
  childId: z.string().min(1),
  schoolYear: z.coerce.number().int().min(2020).max(2100),
  startDate: isoDate,
  entryTime: hhmm,
  exitTime: hhmm,
  monthlyFeeCents: z.coerce.number().min(0).max(100000).transform((v) => Math.round(v * 100)),
}).refine((v) => v.entryTime < v.exitTime, { message: "La salida debe ser posterior a la entrada", path: ["exitTime"] });

export const daycareIncidentSchema = z.object({
  childId: z.string().min(1),
  type: z.enum(["FALL", "ALLERGY", "BEHAVIOR", "HEALTH", "OTHER"]),
  description: z.string().trim().min(3).max(1000),
  parentNotified: z.string().optional().transform((v) => v === "on"),
});

export const daycareProfileSchema = z.object({
  childId: z.string().min(1),
  bloodType: optional(5),
  pediatrician: optional(120),
  pediatricianPhone: optional(20),
  insurance: optional(120),
  medications: optional(500),
  dietaryNotes: optional(500),
  emergencyContactName: optional(120),
  emergencyContactPhone: optional(20),
  photoConsent: z.string().optional().transform((v) => v === "on"),
});
