"use client";
import { useActionState } from "react";
import { issueAccessCodeAction } from "@/actions/portal-admin";
import { formatAccessCode } from "@/lib/portal/identity";

export function AccessCodeForm({ guardianId, enabled, waActive = false }: { guardianId: string; enabled: boolean; waActive?: boolean }) {
  const [s, action, pending] = useActionState(issueAccessCodeAction, undefined);
  if (!enabled) return null;
  return (
    <form action={action} className="inline-flex flex-wrap items-center gap-2">
      <input type="hidden" name="guardianId" value={guardianId} />
      {waActive && <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="sendWhatsApp" defaultChecked /> Enviar por WhatsApp</label>}
      <button disabled={pending} className="h-7 rounded-md border border-input px-2 text-xs">Código de acceso al portal</button>
      {s?.error && <span role="alert" className="text-xs text-red-400">{s.error}</span>}
      {s?.code && (
        <span className="rounded-md bg-amber-500/10 p-2 text-xs">
          Código de {s.guardianName}: <b className="font-mono text-base">{formatAccessCode(s.code)}</b> · vale {s.minutes} min y se usa una sola vez · portal: <b className="font-mono">{s.portalCode}</b>
          <br />{s.whatsapp ?? "Se muestra una sola vez: entrégaselo al apoderado."}
        </span>
      )}
    </form>
  );
}
