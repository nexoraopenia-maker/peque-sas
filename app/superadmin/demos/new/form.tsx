"use client";
import Link from "next/link";
import { useActionState } from "react";
import { createDemoAction } from "@/actions/superadmin";
import { BUSINESS_TYPES, MODULE_KEYS, MODULE_LABEL } from "@/lib/superadmin/pure";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

const BT: Record<string, string> = { ludoteca: "Ludoteca", guarderia: "Guardería", ludoteca_guarderia: "Ludoteca + guardería", otro: "Otro" };

export function DemoForm({ defaultExpiry }: { defaultExpiry: string }) {
  const [s, action, pending] = useActionState(createDemoAction, undefined);
  const label = "block text-sm";
  if (s?.created) {
    const c = s.created;
    return (
      <div className="space-y-3 rounded-lg border border-border p-4 text-sm">
        <p className="font-semibold">Demo creada (vence el {c.expiresAt}). {Object.entries(c.counts).map(([k, v]) => `${v} ${k}`).join(" · ")}</p>
        <div className="rounded-md bg-amber-500/10 p-3">
          <p className="mb-2 font-semibold">Credenciales (se muestran UNA sola vez; cada usuario debe cambiarla en su primer ingreso):</p>
          {c.credentials.map((x) => <p key={x.email}>{x.role} · {x.name} · {x.email} · <code className="font-bold">{x.password}</code></p>)}
        </div>
        <Link href={`/superadmin/tenants/${c.tenantId}`} className="underline">Ver establecimiento</Link>
      </div>
    );
  }
  return (
    <form action={action} className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-2">
      <label className={label}>Nombre comercial<Input name="name" required minLength={3} maxLength={80} /></label>
      <label className={label}>Tipo de negocio
        <select name="businessType" className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">{BUSINESS_TYPES.map((b) => <option key={b} value={b}>{BT[b]}</option>)}</select></label>
      <label className={label}>Correo empresarial del administrador<Input name="adminEmail" type="email" required /></label>
      <label className={label}>Nombre del administrador<Input name="adminName" required maxLength={80} /></label>
      <label className={label}>Contraseña temporal (vacío = generar una segura)<Input name="password" type="text" autoComplete="off" minLength={12} maxLength={100} /></label>
      <label className={label}>Vence (máx. 90 días)<Input name="expiresAt" type="date" required defaultValue={defaultExpiry} /></label>
      <fieldset className="flex flex-wrap gap-3 text-sm sm:col-span-2">
        <legend className="mb-1">Módulos habilitados</legend>
        {MODULE_KEYS.map((k) => <label key={k} className="flex items-center gap-1"><input type="checkbox" name="modules" value={k} defaultChecked={k === "PLAYGROUND" || k === "DAYCARE"} /> {MODULE_LABEL[k]}</label>)}
      </fieldset>
      <label className={label}>Usuarios máx. (3–20)<Input name="maxUsers" type="number" min={3} max={20} defaultValue={5} /></label>
      <label className={label}>Almacenamiento (MB)<Input name="storageMb" type="number" min={50} max={5000} defaultValue={200} /></label>
      <label className={label}>Respuestas del bot / mes<Input name="botMonthlyReplies" type="number" min={0} max={5000} defaultValue={300} /></label>
      <div className="flex items-end gap-4 text-sm">
        <label className="flex items-center gap-1"><input type="checkbox" name="automationsEnabled" /> Automatizaciones (chatbot; requiere el módulo WhatsApp)</label>
      </div>
      {s?.error && <p role="alert" className="text-sm text-red-400 sm:col-span-2">{s.error}</p>}
      <Button disabled={pending} className="sm:col-span-2 sm:w-fit">{pending ? "Creando…" : "Crear demo"}</Button>
    </form>
  );
}
