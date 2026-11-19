import { redirect } from "next/navigation";
import type { VoucherChoice } from "./service";

/** Lee los campos opcionales de comprobante del formulario de cobro: voucher, vDoc, vName, vAddress, vEmail. */
export function voucherFromForm(form: FormData): VoucherChoice {
  const t = String(form.get("voucher") ?? "");
  const doc = String(form.get("vDoc") ?? "").trim();
  return {
    type: t === "BOLETA" || t === "FACTURA" ? t : "",
    customer: { docType: t === "FACTURA" ? "RUC" : doc ? "DNI" : "NONE", docNumber: doc, name: String(form.get("vName") ?? ""), address: String(form.get("vAddress") ?? ""), email: String(form.get("vEmail") ?? "") },
  };
}

/** Termina una acción de cobro: va a la página de la venta, con un aviso si el comprobante no se pudo emitir. */
export function toSale(saleId: string, warning: string | null): never {
  redirect(`/cash-register/sales/${saleId}${warning ? `?e=${encodeURIComponent(warning)}` : ""}`);
}
