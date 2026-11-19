import { z } from "zod";

export type LogKind = "MEAL" | "NAP" | "DIAPER" | "HYGIENE" | "MOOD" | "NOTE";

export const SUBTYPES = {
  MEAL: { BREAKFAST: "Desayuno", LUNCH: "Almuerzo", SNACK: "Lonchera" },
  DIAPER: { WET: "Mojado", DIRTY: "Sucio", BOTH: "Mojado y sucio" },
  HYGIENE: { HANDWASH: "Lavado de manos", TOOTHBRUSH: "Cepillado", BATH: "Baño", CLOTHES: "Cambio de ropa" },
  MOOD: { HAPPY: "Feliz", CALM: "Tranquilo", TIRED: "Cansado", UPSET: "Molesto", SICK: "Con malestar" },
} as const;

export const LEVELS = { ALL: "todo", MOST: "casi todo", HALF: "la mitad", LITTLE: "poco", NONE: "nada" } as const;

const key = <T extends Record<string, string>>(o: T) => Object.keys(o) as [keyof T & string, ...(keyof T & string)[]];
const notes = z.string().trim().max(500).optional().transform((v) => (v ? v : undefined));

export const logInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("MEAL"), childId: z.string().min(1), subtype: z.enum(key(SUBTYPES.MEAL)), level: z.enum(key(LEVELS)), notes }),
  z.object({ kind: z.literal("DIAPER"), childId: z.string().min(1), subtype: z.enum(key(SUBTYPES.DIAPER)), notes }),
  z.object({ kind: z.literal("HYGIENE"), childId: z.string().min(1), subtype: z.enum(key(SUBTYPES.HYGIENE)), notes }),
  z.object({ kind: z.literal("MOOD"), childId: z.string().min(1), subtype: z.enum(key(SUBTYPES.MOOD)), notes }),
  z.object({ kind: z.literal("NOTE"), childId: z.string().min(1), notes: z.string().trim().min(2).max(500), visible: z.string().optional() }),
]);

/** Texto para los padres. No incluye datos médicos más allá de lo registrado en la pizarra. */
export function describeLog(l: { kind: LogKind; subtype?: string | null; level?: string | null; notes?: string | null; endedAt?: Date | null; occurredAt?: Date }): string {
  const sub = (l.kind in SUBTYPES && l.subtype ? (SUBTYPES as Record<string, Record<string, string>>)[l.kind]?.[l.subtype] : undefined) ?? "";
  const extra = l.notes ? ` (${l.notes})` : "";
  switch (l.kind) {
    case "MEAL": return `${sub}: comió ${LEVELS[l.level as keyof typeof LEVELS] ?? "—"}${extra}`;
    case "NAP": return l.endedAt && l.occurredAt ? `Siesta de ${Math.max(1, Math.round((l.endedAt.getTime() - l.occurredAt.getTime()) / 60000))} min${extra}` : `Se durmió${extra}`;
    case "DIAPER": return `Cambio de pañal: ${sub.toLowerCase()}${extra}`;
    case "HYGIENE": return `Higiene: ${sub.toLowerCase()}${extra}`;
    case "MOOD": return `Estado de ánimo: ${sub.toLowerCase()}${extra}`;
    default: return l.notes ?? "";
  }
}
