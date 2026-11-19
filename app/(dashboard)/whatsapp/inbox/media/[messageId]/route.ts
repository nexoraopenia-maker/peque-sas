import { getCurrentUser } from "@/lib/rbac";
import { hasPermission } from "@/lib/rbac/permissions";
import { db } from "@/lib/db";
import { downloadMedia } from "@/lib/whatsapp/graph";
import { graphConfigFor } from "@/lib/whatsapp/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Solo imágenes se muestran en línea; todo lo demás se descarga. Nunca se confía en el tipo que informa el remitente.
const INLINE = new Set(["image/jpeg", "image/png", "image/webp"]);
const KNOWN = new Set([...INLINE, "application/pdf", "audio/mpeg", "audio/ogg", "audio/aac", "audio/amr", "audio/mp4", "video/mp4", "video/3gpp"]);

/**
 * Archivos de WhatsApp: no se guardan (no hay almacenamiento). Se piden a Meta en el momento (la URL vence a los 5 minutos) con el token del
 * establecimiento y se entregan SOLO a personal autorizado de ese mismo establecimiento, con cabeceras que impiden ejecutarlos en el navegador.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ messageId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new Response("No autenticado", { status: 401 });
  if (!user.tenantId || user.mustChangePassword || !hasPermission(user.role, "whatsapp:use")) return new Response("No autorizado", { status: 403 });
  const { messageId } = await params;
  const m = await db.whatsAppMessage.findFirst({ where: { id: messageId.slice(0, 64), tenantId: user.tenantId, mediaId: { not: null } } });
  const g = m ? await graphConfigFor(user.tenantId) : null;
  if (!m || !g) return new Response("No encontrado", { status: 404 });
  try {
    const f = await downloadMedia(g, m.mediaId!);
    const mime = KNOWN.has(f.mime) ? f.mime : "application/octet-stream";
    const name = (m.mediaFilename ?? "archivo").replace(/[^\w.\- ]/g, "_").slice(0, 80);
    return new Response(new Uint8Array(f.bytes), { headers: {
      "Content-Type": mime,
      "Content-Disposition": `${INLINE.has(mime) ? "inline" : "attachment"}; filename="${name}"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store",
    } });
  } catch {
    return new Response("No se pudo obtener el archivo (puede haber vencido en Meta)", { status: 502 });
  }
}
