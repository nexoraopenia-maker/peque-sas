import { randomUUID } from "node:crypto";
import { createExpenseAction } from "@/actions/expenses";
import { CATEGORIES, CATEGORY_LABEL, SOURCES, SOURCE_LABEL } from "@/lib/expenses/pure";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

/** Formulario de gasto. El cajero solo ve insumos operativos pagados del cajón; el servidor lo impone igualmente. */
export function ExpenseForm({ canManage, back, limitCents }: { canManage: boolean; back: "/expenses" | "/cash-register"; limitCents: number }) {
  const sel = "h-9 rounded-md border border-input bg-background px-2 text-sm";
  return (
    <form action={createExpenseAction} className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-3">
      <input type="hidden" name="key" value={randomUUID()} /><input type="hidden" name="back" value={back} />
      <label className="text-sm">Categoría
        <select name="category" required className={sel + " w-full"}>
          {(canManage ? CATEGORIES : (["OPERATING_SUPPLIES"] as const)).map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
        </select>
      </label>
      <label className="text-sm">Pagado con
        <select name="source" required className={sel + " w-full"}>
          {(canManage ? SOURCES : (["CASH_DRAWER"] as const)).map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
        </select>
      </label>
      <label className="text-sm">Monto (S/)<Input name="amount" inputMode="decimal" required placeholder="0.00" /></label>
      <label className="text-sm sm:col-span-2">Descripción<Input name="description" required minLength={3} maxLength={200} /></label>
      {canManage ? <label className="text-sm">Fecha<Input name="date" type="date" /></label> : <span />}
      <label className="text-sm">Proveedor (opcional)<Input name="supplier" maxLength={120} /></label>
      <label className="text-sm">Referencia / comprobante (opcional)<Input name="reference" maxLength={120} /></label>
      <Button className="self-end">Registrar gasto</Button>
      {!canManage && <p className="text-xs text-muted-foreground sm:col-span-3">Sale del efectivo del cajón del turno abierto y baja el efectivo esperado. Máximo S/ {(limitCents / 100).toFixed(2)} por gasto; los gastos mayores los registra el propietario o un administrador.</p>}
    </form>
  );
}
