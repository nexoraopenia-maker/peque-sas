"use client";
import { useActionState } from "react";
import { resetOwnerPasswordAction } from "@/actions/superadmin";
import { Button } from "@/components/ui/button";

export function ResetOwnerForm({ tenantId }: { tenantId: string }) {
  const [s, action, pending] = useActionState(resetOwnerPasswordAction, undefined);
  return (
    <form action={action} className="space-y-2 rounded-lg border border-border p-3 text-sm">
      <input type="hidden" name="tenantId" value={tenantId} />
      <Button size="sm" variant="outline" disabled={pending}>Restablecer contraseña del propietario</Button>
      {s?.error && <p role="alert" className="text-red-400">{s.error}</p>}
      {s?.reset && <p className="rounded-md bg-amber-500/10 p-3">Contraseña temporal de {s.reset.email}: <code className="font-bold">{s.reset.tempPassword}</code><br />Se muestra una sola vez y debe cambiarse al ingresar. Sus sesiones abiertas se cerraron.</p>}
    </form>
  );
}
