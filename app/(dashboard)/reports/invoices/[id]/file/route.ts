import { z } from "zod";
import { getCurrentUser } from "@/lib/rbac";
import { hasPermission } from "@/lib/rbac/permissions";
import { db } from "@/lib/db";
import { docNumber } from "@/lib/sunat/pure";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Descarga el PDF o XML guardado. Tenant y permiso salen de la sesión; el id de la URL solo se busca dentro del tenant. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new Response("No autenticado", { status: 401 });
  if (user.role === "SUPERADMIN" || !user.tenantId || !hasPermission(user.role, "sunat:issue")) return new Response("No autorizado", { status: 403 });
  const kind = z.enum(["pdf", "xml"]).safeParse(new URL(req.url).searchParams.get("kind"));
  if (!kind.success) return new Response("Parámetros inválidos", { status: 400 });
  const { id } = await ctx.params;
  const d = await db.sunatDocument.findFirst({ where: { id, tenantId: user.tenantId } });
  if (!d) return new Response("No encontrado", { status: 404 });
  const body = kind.data === "pdf" ? d.pdf : d.xml;
  if (!body) return new Response("Archivo aún no disponible", { status: 404 });
  const name = `${docNumber(d.serie, d.number)}.${kind.data}`;
  return new Response(typeof body === "string" ? body : new Uint8Array(body), {
    headers: {
      "Content-Type": kind.data === "pdf" ? "application/pdf" : "application/xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    },
  });
}
