import { VoucherFields } from "./voucher-fields";
import { METHODS, METHOD_LABEL } from "@/lib/billing/money";

const sel = "h-9 rounded-md border border-input bg-background px-2 text-sm";

/** Método de pago; opcionalmente un monto parcial y un segundo método para el resto (pago mixto). */
export function PaymentFields() {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <select name="method" required defaultValue="EFECTIVO" className={sel} aria-label="Método de pago">
        {METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
      </select>
      <input name="amount" inputMode="decimal" placeholder="Monto (vacío = todo)" className={sel + " w-36"} aria-label="Monto con este método" />
      <select name="method2" defaultValue="" className={sel} aria-label="Método para el resto">
        <option value="">Resto con…</option>
        {METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
      </select>
      <VoucherFields />
    </span>
  );
}
