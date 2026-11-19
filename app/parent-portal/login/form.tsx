"use client";
import { useActionState } from "react";
import { parentLoginAction, requestCodeAction } from "@/actions/portal";

export function ParentLoginForm({ portalCode }: { portalCode: string }) {
  const [s, action, pending] = useActionState(parentLoginAction, undefined);
  const input = "h-11 w-full rounded-md border border-input bg-transparent px-3 text-base";
  return (
    <form action={action} className="flex flex-col gap-3">
      <label className="text-sm">Código del establecimiento
        <input name="portalCode" defaultValue={portalCode} required autoCapitalize="characters" autoComplete="off" className={input + " font-mono uppercase"} /></label>
      <label className="text-sm">DNI o teléfono
        <input name="identifier" required inputMode="numeric" autoComplete="off" placeholder="8 dígitos (DNI) o 9 (celular)" className={input} /></label>
      <label className="text-sm">Código de acceso
        <input name="code" required inputMode="numeric" autoComplete="one-time-code" placeholder="8 dígitos entregados por el establecimiento" className={input + " font-mono"} /></label>
      {s?.error && <p role="alert" className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">{s.error}</p>}
      <button disabled={pending} className="h-11 rounded-md bg-primary font-medium text-primary-foreground disabled:opacity-50">{pending ? "Verificando…" : "Ingresar"}</button>
    </form>
  );
}

export function RequestCodeForm({ portalCode }: { portalCode: string }) {
  const [s, action, pending] = useActionState(requestCodeAction, undefined);
  const input = "h-11 w-full rounded-md border border-input bg-transparent px-3 text-base";
  return (
    <details className="rounded-md border border-border p-3">
      <summary className="cursor-pointer text-sm">¿No tienes código? Recíbelo por WhatsApp</summary>
      <form action={action} className="mt-3 flex flex-col gap-3">
        <input name="portalCode" defaultValue={portalCode} required autoCapitalize="characters" autoComplete="off" className={input + " font-mono uppercase"} aria-label="Código del establecimiento" />
        <input name="identifier" required inputMode="numeric" autoComplete="off" placeholder="Tu DNI o celular registrado" className={input} aria-label="DNI o teléfono" />
        {s?.message && <p role="status" className="text-sm text-muted-foreground">{s.message}</p>}
        <button disabled={pending} className="h-10 rounded-md border border-input text-sm disabled:opacity-50">{pending ? "Enviando…" : "Enviar código por WhatsApp"}</button>
      </form>
    </details>
  );
}
