import { z } from "zod";
import { getCurrentUser } from "@/lib/rbac";
import { hasPermission } from "@/lib/rbac/permissions";
import { featureEnabled } from "@/lib/plans/pure";
import { audit } from "@/lib/audit";
import { getReport } from "@/lib/reports/service";
import { expensesCsv, expensesPdf, summaryCsv, summaryPdf } from "@/lib/reports/export";
import { validateRange } from "@/lib/reports/pure";
import { listExpenses } from "@/lib/expenses/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const q = z.object({
  type: z.enum(["summary", "expenses"]).default("summary"), format: z.enum(["csv", "pdf"]),
  from: z.iso.date(), to: z.iso.date(), g: z.enum(["DAY", "WEEK", "MONTH"]).default("DAY"),
});

/** Exportación gerencial (solo OWNER/ADMIN): la autorización y el tenant salen de la sesión, nunca de la URL. */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return new Response("No autenticado", { status: 401 });
  if (user.role === "SUPERADMIN" || !user.tenantId || !hasPermission(user.role, "reports:view")) return new Response("No autorizado", { status: 403 });
  if (!user.tenant || !featureEnabled(user.tenant, "REPORTS")) return new Response("Los reportes no están incluidos en tu plan", { status: 403 });
  const p = q.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!p.success) return new Response("Parámetros inválidos", { status: 400 });
  const { type, format, from, to, g } = p.data;
  const bad = validateRange(from, to); if (bad) return new Response(bad, { status: 400 });
  const tenantId = user.tenantId, name = user.tenant?.name ?? "Establecimiento";
  let body: string | Buffer;
  if (type === "summary") { const r = await getReport(tenantId, from, to, g); body = format === "csv" ? summaryCsv(r, name) : summaryPdf(r, name); }
  else { const list = await listExpenses(tenantId, { from, to, includeVoided: true }, 5000); body = format === "csv" ? expensesCsv(list, from, to) : expensesPdf(list, from, to, name); }
  await audit({ tenantId, actorId: user.id, action: "report.export", entity: "Report", metadata: { type, format, from, to } });
  return new Response(typeof body === "string" ? body : new Uint8Array(body), {
    headers: {
      "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/pdf",
      "Content-Disposition": `attachment; filename="${type === "summary" ? "reporte" : "gastos"}-${from}_${to}.${format}"`,
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    },
  });
}
