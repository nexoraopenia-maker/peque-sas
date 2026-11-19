"use server";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/rbac";
import { tenantDb } from "@/lib/db/tenant";
import { productSchema, movementSchema } from "@/lib/validation/schemas";
import { stockDelta } from "@/lib/inventory/stock";
import { audit } from "@/lib/audit";

type State = { error?: string; ok?: boolean } | undefined;

export async function createProductAction(_p: State, form: FormData): Promise<State> {
  const { user, tenantId } = await requirePermission("inventory:manage");
  const parsed = productSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: "Revisa los datos del formulario" };
  try {
    const p = await tenantDb(tenantId).product.create({ data: parsed.data as never });
    await audit({ tenantId, actorId: user.id, action: "product.create", entity: "Product", entityId: p.id });
  } catch {
    return { error: "No se pudo crear (¿SKU duplicado?)" };
  }
  revalidatePath("/products");
  return { ok: true };
}

export async function registerMovementAction(_p: State, form: FormData): Promise<State> {
  const { user, tenantId } = await requirePermission("inventory:manage");
  const parsed = movementSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: "Revisa los datos del formulario" };
  const { productId, type, quantity, reason } = parsed.data;
  const tdb = tenantDb(tenantId);

  try {
    await tdb.$transaction(async (tx) => {
      const product = await tx.product.findFirst({ where: { id: productId } });
      if (!product) throw new Error("Producto no encontrado");
      const delta = stockDelta(type, quantity, product.stock);
      // Actualización condicional atómica: evita saldos negativos con movimientos concurrentes
      const r = await tx.product.updateMany({
        where: { id: productId, stock: { gte: Math.max(0, -delta) } },
        data: { stock: { increment: delta } },
      });
      if (r.count !== 1) throw new Error("Stock insuficiente");
      const after = await tx.product.findFirst({ where: { id: productId } });
      await tx.stockMovement.create({
        data: { productId, type, quantity, reason, stockAfter: after!.stock, createdById: user.id } as never,
      });
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Error al registrar" };
  }
  revalidatePath("/products");
  return { ok: true };
}
