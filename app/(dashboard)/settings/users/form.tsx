"use client";
import { useActionState } from "react";
import { createWorkerAction } from "@/actions/workers";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function WorkerForm() {
  const [s, action, pending] = useActionState(createWorkerAction, undefined);
  return (
    <form action={action} className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-4">
      <Input name="name" placeholder="Nombre" required />
      <Input name="email" type="email" placeholder="Correo" required />
      <select name="role" className="h-9 rounded-md border border-input bg-background px-3 text-sm">
        <option value="RECEPTION">Recepción</option>
        <option value="TEACHER">Profesora</option>
        <option value="ADMIN">Administrador</option>
      </select>
      <Button disabled={pending}>Crear trabajador</Button>
      {s?.error && <p role="alert" className="text-sm text-red-400 sm:col-span-4">{s.error}</p>}
      {s?.created && (
        <p className="rounded-md bg-amber-500/10 p-3 text-sm sm:col-span-4">
          Contraseña temporal de {s.created.email}: <code className="font-bold">{s.created.tempPassword}</code>
          <br />Se muestra una sola vez. Deberá cambiarla en su primer ingreso.
        </p>
      )}
    </form>
  );
}
