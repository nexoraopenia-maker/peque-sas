"use client";
import { useActionState } from "react";
import { changePasswordAction } from "@/actions/password";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function ChangePasswordForm() {
  const [s, action, pending] = useActionState(changePasswordAction, undefined);
  return (
    <form action={action} className="flex flex-col gap-3">
      <Input name="current" type="password" placeholder="Contraseña actual" autoComplete="current-password" required />
      <Input name="next" type="password" placeholder="Nueva contraseña (mín. 10)" autoComplete="new-password" required minLength={10} />
      <Input name="confirm" type="password" placeholder="Confirmar" autoComplete="new-password" required />
      <div aria-live="polite">{s?.error && <p role="alert" className="rounded-md border border-red-500/40 bg-red-500/10 p-2 text-sm text-red-300">{s.error}</p>}</div>
      <Button disabled={pending}>{pending ? "Guardando…" : "Guardar"}</Button>
    </form>
  );
}
