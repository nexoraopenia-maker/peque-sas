# Fase 13 — Marketing y fidelización

Estado: **implementada y probada contra Turso real con un doble de la API de Meta**. Nunca se envió una plantilla comercial por la API real de Meta.

## 1. Reglas de negocio (decididas por el propietario del producto)
| Regla | Valor por defecto | Configurable por establecimiento |
|---|---|---|
| Puntos | 1 punto por cada S/ 1.00 **pagado** (soles completos; los céntimos no suman) | `LoyaltyConfig.pointsPerSol` (entero) |
| Vencimiento | 365 días | `expiryDays` (0 = no vencen) |
| Valor al canjear | S/ 0.10 por punto | `centsPerPoint` |
| Tope de canje | 50 % de lo que queda por pagar | `maxRedeemPercent` |
| Cupones | crear, editar, desactivar: **solo OWNER y ADMIN** (`coupons:manage`). RECEPTION solo consulta (`coupons:view`) y aplica en caja (`cash:use`) | — |

Todo en enteros/céntimos. Los puntos se acreditan **sobre lo realmente pagado** (después de cupón y canje), en todos los cobros: venta de productos, salida de ludoteca, cuponera, mensualidad y pago de reserva.

## 2. Datos (migración `0011_marketing_loyalty`)
- `LoyaltyLedger`: libro **inmutable** (trigger) por apoderado; `Guardian.loyaltyPoints` es el saldo derivado con `CHECK >= 0`. Únicos `(tenantId, saleId, type)` (una venta acredita una sola vez) y `(tenantId, lotId, type)` (un lote vence una sola vez).
- `Coupon` (`PERCENTAGE` | `FIXED_CENTS`, vigencia, límite global, límite por familia, compra mínima, `CHECK` de coherencia) y `CouponRedemption` (único por venta).
- `ConsentEvent` inmutable + columnas de consentimiento en `Guardian` (`marketingConsent`, fecha, origen, quién lo registró, fecha de revocación).
- `Campaign` y `CampaignRecipient` (único por campaña y apoderado).
- `Sale`: `discountCents`, `couponId`, `pointsRedeemed`, `pointsEarned`, `loyaltyGuardianId`. Los descuentos son ítems negativos (`COUPON_DISCOUNT`, `POINTS_DISCOUNT`), por lo que los ítems siempre suman el total.

## 3. Atomicidad
Cupón, canje, acreditación y venta ocurren en **una sola transacción** (`createSaleWithPromos`). El servidor recalcula todo; el navegador solo envía el código, los puntos a canjear y el DNI/teléfono del apoderado.
- Uso global: `UPDATE … SET usesCount = usesCount + 1 WHERE usesCount < maxUses` condicional.
- Por familia: `INSERT … SELECT … WHERE (usos de la familia) < límite` condicional.
- Puntos: `INSERT … SELECT … WHERE saldo + delta >= 0`, luego se actualiza el saldo. Dos canjes simultáneos no pueden dejar el saldo negativo.
- Si algo falla se revierte **todo** (cupón, puntos, stock, venta).
- Los puntos vencidos se calculan con el libro (FIFO) y se descuentan una sola vez; la tarea diaria `GET /api/cron/marketing` (`CRON_SECRET`) vence puntos y continúa campañas a medias.

## 4. Consentimiento comercial (Ley 29733)
- **Por defecto no hay consentimiento.** Ninguna campaña llega a quien no lo registró.
- Lo registra el personal (exige constancia de cómo se obtuvo: ≥ 3 caracteres), el propio apoderado en el Portal de padres (`PORTAL`) o se revoca por WhatsApp.
- Cada cambio deja un evento **inmutable** con fecha, origen y constancia; repetir el mismo estado no duplica la prueba.
- **Baja por WhatsApp**: el mensaje que sea exactamente «BAJA» (o `STOP`, «no quiero más promociones», etc.; coincidencia exacta, no por frase suelta) revoca el consentimiento **solo del establecimiento que recibió el mensaje**, aunque el bot esté apagado, y confirma la baja.
- El consentimiento se comprueba **dos veces**: al armar la audiencia y de nuevo justo antes de enviar a cada destinatario (si alguien revoca después de la vista previa, no se le envía).
- Tope de frecuencia: una campaña cada 7 días por persona.

## 5. Campañas y segmentos (`/marketing/campaigns`, solo OWNER/ADMIN)
| Segmento | Criterio |
|---|---|
| Cumpleaños del mes | menor con cumpleaños en el mes actual (hora de Lima) |
| Inactivos | sin ventas ni sesiones en N días (30 por defecto) y sin matrícula activa |
| Cuponera por agotarse | saldo entre 1 y N minutos (60 por defecto) |

Se envían como **plantillas oficiales de Meta** (`template`), nunca como texto libre. Parámetros: nombre del apoderado, [nombre del menor], [minutos], [cupón]. **Cada plantilla debe incluir «Responde BAJA para no recibir más promociones»** y estar aprobada en Meta (categoría Marketing) antes de usarla.

## 6. Pantallas
`/marketing` (inicio), `/marketing/coupons`, `/marketing/loyalty` (reglas + saldo y movimientos por apoderado), `/marketing/campaigns` (vista previa de audiencia con excluidos), `/marketing/campaigns/[id]`; campos de cupón/puntos en `/cash-register` y en la salida de `/playground/live`; consentimiento en `/families`; puntos y preferencia de promociones en `/parent-portal`.

## 7. Limitaciones conocidas
1. **Nunca se envió una campaña por la API real de Meta** (todas las pruebas usan un doble). Cada plantilla debe aprobarse en Meta y probarse con un número propio antes de una campaña real.
2. Los cupones se aplican en **venta de productos y salida de ludoteca**; no en cuponera, mensualidad ni pago de reserva (esos cobros solo acreditan puntos).
3. «Por familia» = por apoderado (`guardianId`).
4. No hay ajustes manuales de puntos, devoluciones ni anulación de ventas (los puntos de una venta no se revierten porque aún no existen anulaciones).
5. La tarea diaria es de frecuencia diaria (límite del plan Hobby de Vercel); el vencimiento es exacto porque se calcula al canjear, la tarea solo lo registra.
6. La detección de «BAJA» es por palabra clave exacta; una frase ambigua no revoca (queda para atención humana).
7. El consentimiento existente (antes de esta fase) es «sin autorización»: hay que registrarlo.
8. No hay estadísticas de conversión de campañas ni segmentos personalizados.
