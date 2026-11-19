"use client";
import { useActionState } from "react";
import { createProductAction, registerMovementAction } from "@/actions/products";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function ProductForm() {
  const [s, action, pending] = useActionState(createProductAction, undefined);
  return (
    <form action={action} className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-5">
      <Input name="name" placeholder="Producto" required className="sm:col-span-2" />
      <Input name="sku" placeholder="SKU" />
      <Input name="priceCents" type="number" step="0.01" min="0" placeholder="Precio S/" required />
      <Input name="minStock" type="number" min="0" placeholder="Stock mínimo" defaultValue={0} required />
      {s?.error && <p role="alert" className="text-sm text-red-400 sm:col-span-5">{s.error}</p>}
      <Button disabled={pending} className="sm:col-span-5">Crear producto</Button>
    </form>
  );
}

export function MovementForm({ products }: { products: { id: string; name: string }[] }) {
  const [s, action, pending] = useActionState(registerMovementAction, undefined);
  const sel = "h-9 rounded-md border border-input bg-background px-3 text-sm";
  return (
    <form action={action} className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-5">
      <select name="productId" required className={sel}>
        {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <select name="type" className={sel}>
        <option value="IN">Entrada</option>
        <option value="OUT">Salida</option>
        <option value="ADJUST">Ajuste (fija el stock)</option>
      </select>
      <Input name="quantity" type="number" min="0" placeholder="Cantidad" required />
      <Input name="reason" placeholder="Motivo" />
      <Button disabled={pending || products.length === 0}>Registrar</Button>
      {s?.error && <p role="alert" className="text-sm text-red-400 sm:col-span-5">{s.error}</p>}
    </form>
  );
}
