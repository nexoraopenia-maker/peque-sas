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
      {s?.error && <p role="alert" className="text-sm text-red-400">{s.error}</p>}
      <Button disabled={pending}>Guardar</Button>
    </form>
  );
}
