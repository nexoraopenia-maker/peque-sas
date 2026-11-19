"use client";
import { useActionState } from "react";
import { checkInAction, createIncidentAction, createRateAction } from "@/actions/playground";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

const sel = "h-9 rounded-md border border-input bg-background px-3 text-sm";

export function RateForm() {
  const [s, action, pending] = useActionState(createRateAction, undefined);
  return (
    <form action={action} className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-5">
      <Input name="name" placeholder="Nombre (ej. 1 hora)" required />
      <Input name="minutes" type="number" min="5" placeholder="Minutos" required />
      <Input name="priceCents" type="number" step="0.01" min="0" placeholder="Precio S/" required />
      <Input name="extraMinuteCents" type="number" step="0.01" min="0" placeholder="S/ por minuto extra" defaultValue="0" required />
      <Button disabled={pending}>Crear tarifa</Button>
      {s?.error && <p role="alert" className="text-sm text-red-400 sm:col-span-5">{s.error}</p>}
    </form>
  );
}

export function CheckInForm({ children, rates }: { children: { id: string; name: string }[]; rates: { id: string; label: string }[] }) {
  const [s, action, pending] = useActionState(checkInAction, undefined);
  return (
    <form action={action} className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-4">
      <select name="childId" required className={sel}>{children.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      <select name="rateId" required className={sel}>{rates.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select>
      <Input name="braceletCode" placeholder="Pulsera" required />
      <Button disabled={pending || !children.length || !rates.length}>Registrar ingreso</Button>
      {s?.error && <p role="alert" className="text-sm text-red-400 sm:col-span-4">{s.error}</p>}
    </form>
  );
}

export function IncidentForm({ childId, sessionId }: { childId: string; sessionId?: string }) {
  const [s, action, pending] = useActionState(createIncidentAction, undefined);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="childId" value={childId} />
      {sessionId && <input type="hidden" name="sessionId" value={sessionId} />}
      <select name="type" className={sel + " h-8"}>
        <option value="FALL">Caída</option><option value="ALLERGY">Alergia</option><option value="BEHAVIOR">Conducta</option>
        <option value="HEALTH">Salud</option><option value="OTHER">Otro</option>
      </select>
      <Input name="description" placeholder="Incidencia" required className="h-8 w-48" />
      <Button size="sm" variant="outline" disabled={pending}>Registrar</Button>
      {s?.ok && <span className="text-xs text-green-400">Registrada</span>}
      {s?.error && <span role="alert" className="text-xs text-red-400">{s.error}</span>}
    </form>
  );
}
