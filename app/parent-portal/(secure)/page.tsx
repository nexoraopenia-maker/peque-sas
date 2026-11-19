import Link from "next/link";
import { requireGuardian } from "@/lib/portal/auth";
import { childOverview, finances, myChildren, type Me } from "@/lib/portal/data";
import { requireMyChild } from "@/lib/portal/data";
import { portalConsentAction } from "@/actions/portal";
import { loyaltyBalance } from "@/lib/marketing/loyalty";
import { db } from "@/lib/db";
import { formatSoles } from "@/lib/billing/money";

export const dynamic = "force-dynamic";
const tm = (d: Date | null) => (d ? d.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", timeZone: "America/Lima" }) : "—");

export default async function PortalHome() {
  const g = await requireGuardian();
  const me: Me = { id: g.id, tenantId: g.tenantId };
  const kids = await myChildren(me);
  const cards = await Promise.all(kids.map(async (k) => {
    const mine = await requireMyChild(me, k.id);
    const [o, f] = await Promise.all([childOverview(mine), finances(mine)]);
    return { k, o, f };
  }));
  const [pts, prefs] = await Promise.all([
    loyaltyBalance(g.tenantId, g.id),
    db.guardian.findFirst({ where: { id: g.id, tenantId: g.tenantId }, select: { marketingConsent: true } }),
  ]);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Mis hijos</h1>
      {cards.length === 0 && <p className="text-sm text-muted-foreground">No hay menores vinculados a tu cuenta.</p>}
      <ul className="space-y-3">
        {cards.map(({ k, o, f }) => (
          <li key={k.id} className="space-y-1 rounded-lg border border-border p-4">
            <Link href={`/parent-portal/children/${k.id}`} className="text-lg font-semibold underline">{k.fullName}</Link>
            <p className="text-sm">
              {o.openPlayground ? `🟢 En ludoteca desde las ${tm(o.openPlayground.checkInAt)}` : o.attendance?.status === "PRESENT" ? (o.attendance.checkOutAt ? `Guardería: salió a las ${tm(o.attendance.checkOutAt)}` : `🟢 En guardería desde las ${tm(o.attendance.checkInAt)}`) : o.attendance?.status === "ABSENT" ? "Guardería: ausente hoy" : "Hoy no está en el establecimiento"}
            </p>
            {(k.allergies || k.medicalAlerts) && <p className="text-sm text-amber-400">⚠ {[k.allergies, k.medicalAlerts].filter(Boolean).join(" · ")}</p>}
            {f.overdueCount > 0 && <p className="text-sm text-red-400">Mensualidades vencidas: {f.overdueCount} · {formatSoles(f.overdueCents)}</p>}
            {f.prepaidMinutes > 0 && <p className="text-sm text-muted-foreground">Cuponera: {f.prepaidMinutes} min disponibles</p>}
          </li>
        ))}
      </ul>
      <section className="space-y-2 rounded-lg border border-border p-4 text-sm">
        <p>Mis puntos: <b>{pts.available}</b>{pts.expiringSoon > 0 ? ` (${pts.expiringSoon} vencen en 30 días)` : ""}</p>
        <form action={portalConsentAction} className="space-y-1">
          <input type="hidden" name="granted" value={prefs?.marketingConsent ? "0" : "1"} />
          <p className="text-muted-foreground">{prefs?.marketingConsent ? "Recibes promociones por WhatsApp." : "No recibes promociones por WhatsApp."} También puedes escribir BAJA al chat del establecimiento.</p>
          <button className="underline">{prefs?.marketingConsent ? "Dejar de recibir promociones" : "Quiero recibir promociones por WhatsApp"}</button>
        </form>
      </section>
    </div>
  );
}
