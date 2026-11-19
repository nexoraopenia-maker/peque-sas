/**
 * Verificaciones DETERMINISTAS de la respuesta del bot antes de enviarla (defensa en profundidad contra alucinaciones).
 * Un modelo puede equivocarse aunque el prompt lo prohíba, así que además se comprueba en código que:
 *   1) todo importe en soles citado aparece en lo que devolvieron las herramientas (datos reales) o en los textos del propietario;
 *   2) no se afirma que una reserva está confirmada (solo el equipo confirma);
 *   3) no se afirma ni niega disponibilidad sin haberla consultado, ni contradiciendo la consulta;
 *   4) no se incluyen enlaces ni teléfonos que no provengan de los datos reales (evita phishing por inyección de instrucciones).
 * Son heurísticas: pueden bloquear una respuesta válida (se deriva a una persona) pero no dejan pasar lo que detectan.
 */
export type Verdict = { ok: true } | { ok: false; reason: string };

const toCents = (s: string) => Math.round(parseFloat(s.replace(",", ".")) * 100);

export function extractMoneyCents(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/S\/\.?\s?(\d{1,6}(?:[.,]\d{1,2})?)/gi)) out.push(toCents(m[1]!));
  for (const m of text.matchAll(/(\d{1,6}(?:[.,]\d{1,2})?)\s*(?:soles|nuevos soles|PEN)\b/gi)) out.push(toCents(m[1]!));
  return out;
}
export const extractUrls = (t: string) => [...t.matchAll(/(?:https?:\/\/|www\.)[^\s)>\]]+/gi)].map((m) => m[0].toLowerCase().replace(/[.,;!?]+$/, ""));
export const extractPhones = (t: string) => [...t.matchAll(/(?<!\d)(?:\+?51[\s-]?)?9\d{2}[\s-]?\d{3}[\s-]?\d{3}(?!\d)|\+\d{8,15}/g)].map((m) => m[0].replace(/\D/g, "").replace(/^51(?=9\d{8}$)/, ""));

const NEGATION = /\b(no|aún no|todavía no|sin|pendiente|pendientes|una vez|sujet[oa]|podr[ií]a|podr[aá]|cuando)\b/i;
const BOOKING_NOUN = /\b(reserva|reservas|solicitud|cupo|cupos|lugar|espacio|cita|cumplea[ñn]os|evento|fiesta)\b/i;
const CONFIRM_VERB = /\b(confirmad[oa]s?|asegurad[oa]s?|garantizad[oa]s?|agendad[oa]s?|te confirmo|le confirmo|les confirmo|confirmamos|reservamos|reserv[ée]|apartamos|apart[ée]|qued(?:a|an|ó|aron) (?:reservad|agendad|confirmad)\w*)\b/i;

/** ¿Alguna oración afirma que una reserva/cupo está confirmado o asegurado? */
export function claimsConfirmation(text: string): boolean {
  return text.split(/(?<=[.!?\n])\s+/).some((s) => BOOKING_NOUN.test(s) && CONFIRM_VERB.test(s) && !NEGATION.test(s));
}

const AVAIL_POS = /\b(?:(?:hay|tenemos|queda(?:n)?|contamos con)\s+(?:cupos?|espacios?|lugar(?:es)?|disponibilidad|vacantes?)|(?:est[aá]n?|estar[aá]n?|estar[ií]a)\s+disponibles?|(?:sí|si),?\s+(?:hay|tenemos))\b/i;
const AVAIL_NEG = /\bno\s+(?:hay|tenemos|queda(?:n)?|contamos con)\s+(?:cupos?|espacios?|lugar(?:es)?|disponibilidad|vacantes?)\b|\bno\s+(?:est[aá]n?)\s+disponibles?\b/i;

export type AvailabilityCall = { available: boolean };

export function groundingCheck(reply: string, evidence: { toolOutputs: string[]; staticTexts: string[]; availability: AvailabilityCall[] }): Verdict {
  const text = reply.trim();
  if (!text) return { ok: false, reason: "respuesta vacía" };
  if (text.length > 1500) return { ok: false, reason: "respuesta demasiado larga" };
  const known = [...evidence.toolOutputs, ...evidence.staticTexts].join("\n");

  const allowedMoney = new Set(extractMoneyCents(known));
  const stray = extractMoneyCents(text).filter((c) => !allowedMoney.has(c));
  if (stray.length) return { ok: false, reason: `importe no respaldado por los datos (S/ ${(stray[0]! / 100).toFixed(2)})` };

  if (claimsConfirmation(text)) return { ok: false, reason: "afirma una reserva confirmada" };

  // Las frases negativas ("no hay cupo") se quitan antes de buscar afirmaciones positivas: si no, "hay cupo" aparecería también dentro de ellas
  const neg = AVAIL_NEG.test(text), pos = AVAIL_POS.test(text.replace(new RegExp(AVAIL_NEG.source, "gi"), " "));
  if (pos || neg) {
    if (!evidence.availability.length) return { ok: false, reason: "habla de disponibilidad sin haberla consultado" };
    if (pos && !neg && !evidence.availability.some((a) => a.available)) return { ok: false, reason: "afirma disponibilidad que la consulta negó" };
    if (neg && !pos && !evidence.availability.some((a) => !a.available)) return { ok: false, reason: "niega disponibilidad que la consulta confirmó" };
  }

  const allowedUrls = new Set(extractUrls(known));
  const badUrl = extractUrls(text).find((u) => !allowedUrls.has(u));
  if (badUrl) return { ok: false, reason: "incluye un enlace que no proviene de los datos" };
  const allowedPhones = new Set(extractPhones(known));
  const badPhone = extractPhones(text).find((p) => !allowedPhones.has(p));
  if (badPhone) return { ok: false, reason: "incluye un teléfono que no proviene de los datos" };
  return { ok: true };
}

/** Frases con las que el cliente pide hablar con una persona (se atiende sin llamar a la IA). */
export const wantsHuman = (text: string) =>
  /\b(asesor(?:a)?|humano|persona real|atenci[oó]n (?:humana|personalizada)|recepcionista|encargad[oa]|due[ñn][oa])\b|hablar con (?:una persona|alguien|un humano|un asesor|una asesora|recepci[oó]n|el due[ñn]o|la due[ñn]a|el encargado|la encargada)|(?:p[aá]same|comun[ií]came|ponme|comun[ií]quenme|p[aá]senme) con\b|quiero que me llamen/i.test(text);
