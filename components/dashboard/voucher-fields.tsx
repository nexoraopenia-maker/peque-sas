const sel = "h-9 rounded-md border border-input bg-background px-2 text-sm";

/** Comprobante electrónico opcional al cobrar. Sin elección: según la configuración del establecimiento (boleta automática si está activa). */
export function VoucherFields() {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer select-none text-muted-foreground">Comprobante</summary>
      <span className="mt-1 flex flex-wrap items-center gap-2">
        <select name="voucher" defaultValue="" className={sel} aria-label="Tipo de comprobante">
          <option value="">Según configuración</option><option value="BOLETA">Boleta con DNI</option><option value="FACTURA">Factura (RUC)</option>
        </select>
        <input name="vDoc" inputMode="numeric" maxLength={11} placeholder="DNI o RUC" className={sel + " w-28"} aria-label="DNI o RUC del comprador" />
        <input name="vName" maxLength={200} placeholder="Nombre / razón social" className={sel + " w-44"} aria-label="Nombre o razón social" />
        <input name="vAddress" maxLength={250} placeholder="Dirección (factura)" className={sel + " w-44"} aria-label="Dirección del comprador" />
        <input name="vEmail" type="email" maxLength={120} placeholder="Correo (opcional)" className={sel + " w-40"} aria-label="Correo del comprador" />
      </span>
    </details>
  );
}
