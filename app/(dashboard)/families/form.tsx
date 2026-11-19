"use client";
import { useActionState } from "react";
import { createFamilyAction } from "@/actions/families";
import { addAuthorizedPickupAction } from "@/actions/pickups";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function FamilyForm() {
  const [s, action, pending] = useActionState(createFamilyAction, undefined);
  return (
    <form action={action} className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-2">
      <Input name="guardianName" placeholder="Apoderado (nombre completo)" required />
      <Input name="guardianDni" placeholder="DNI" />
      <Input name="guardianPhone" placeholder="Teléfono" />
      <Input name="guardianEmail" type="email" placeholder="Correo" />
      <Input name="childName" placeholder="Menor (nombre completo)" required />
      <Input name="childBirthDate" type="date" />
      <Input name="relationship" placeholder="Parentesco" />
      <Input name="allergies" placeholder="Alergias" />
      <Input name="medicalAlerts" placeholder="Alertas médicas" className="sm:col-span-2" />
      {s?.error && <p role="alert" className="text-sm text-red-400 sm:col-span-2">{s.error}</p>}
      {s?.ok && <p className="text-sm text-green-400 sm:col-span-2">Familia registrada</p>}
      <Button disabled={pending} className="sm:col-span-2">{pending ? "Guardando…" : "Registrar familia"}</Button>
    </form>
  );
}

export function PickupForm({ childId }: { childId: string }) {
  const [s, action, pending] = useActionState(addAuthorizedPickupAction, undefined);
  return (
    <form action={action} className="mt-1 flex flex-wrap items-center gap-2">
      <input type="hidden" name="childId" value={childId} />
      <Input name="fullName" placeholder="Autorizar a recoger: nombre" required className="h-8 w-48" />
      <Input name="dni" placeholder="DNI" className="h-8 w-24" />
      <Input name="relationship" placeholder="Parentesco" className="h-8 w-28" />
      <Button size="sm" variant="outline" disabled={pending}>Autorizar</Button>
      {s?.error && <span role="alert" className="text-xs text-red-400">{s.error}</span>}
    </form>
  );
}
