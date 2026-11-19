import { Input } from "@/components/ui/input";

/** Cupón, canje de puntos y apoderado (DNI o teléfono) para ganar/canjear puntos. Todo se valida y recalcula en el servidor. */
export function PromoFields({ withGuardian = true }: { withGuardian?: boolean }) {
  return (
    <>
      <Input name="coupon" placeholder="Cupón" maxLength={32} className="h-9 w-28" aria-label="Código de cupón" autoComplete="off" />
      {withGuardian && <Input name="guardian" placeholder="DNI/teléfono apoderado" maxLength={20} className="h-9 w-44" aria-label="DNI o teléfono del apoderado" autoComplete="off" />}
      <Input name="redeem" type="number" min="0" placeholder="Puntos a canjear" className="h-9 w-32" aria-label="Puntos a canjear" />
    </>
  );
}
