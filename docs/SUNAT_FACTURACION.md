# Fase 15 — Facturación electrónica SUNAT (UBL 2.1 vía PSE/OSE)

## 1. Estado honesto de la integración

| Pieza | Estado |
|---|---|
| Modelo de datos, numeración, validaciones RUC/DNI, IGV, notas de crédito, reintentos, panel, cron | Implementado y probado (Turso real + adaptador **simulado**) |
| Adaptador **simulado** (`MockSunatAdapter`) | Operativo. Genera XML/PDF marcados «SIMULADO – SIN VALIDEZ TRIBUTARIA». No contacta a SUNAT |
| Adaptador **Nubefact** (`NubefactAdapter`) | Implementado y probado contra un servidor HTTP local que reproduce el contrato JSON. **NO verificado contra Nubefact real**: no hay cuenta/ruta/token del establecimiento |
| Emisión real ante SUNAT | **No declarada operativa** (regla de `claude.md`: hasta emitir, ser aceptado y consultar comprobantes reales) |

Pendiente de verificar con una cuenta demo de Nubefact (el contrato se implementó de memoria de su documentación; la búsqueda web no devolvió el ejemplo de `generar_comprobante`): formato exacto de la cabecera `Authorization`, nombres de campos de respuesta (`aceptada_por_sunat`, `sunat_responsecode`, `enlace_del_pdf/xml/cdr`, `codigo_hash`, `cadena_para_codigo_qr`), códigos de error (23 = ya existe, 20 = no existe) y numeración de motivos de nota de crédito.

## 2. Patrón adaptador (`lib/sunat/`)

- `adapter.ts`: interfaz `SunatAdapter` (`issue`, `consult`, `testConnection`) y `SunatTransportError` (fallo reintentable).
- `mock.ts`, `nubefact.ts`: implementaciones. `config.ts` elige la implementación por tenant (`adapterFor`).
- `pure.ts`: RUC/DNI, comprador, IGV, ítems, series, URLs permitidas, espera de reintentos (sin BD ni red; probada en `tests/sunat-pure.test.ts`).
- `service.ts`: crear, enviar, reintentar, notas de crédito, cron. `form.ts`: campos de comprobante en los cobros.

Configuración por tenant (`SunatConfig`): `provider`, `sunatApiUrl`, `sunatTokenEnc` (cifrado AES-256-GCM con AAD tenant+campo, igual que WhatsApp; nunca vuelve al navegador), `rucEmisor`, `razonSocial`, series, IGV, `autoIssue`, `enabled`. Solo el propietario (`settings:manage`) la edita.

Seguridad de la URL del PSE (la escribe el tenant → riesgo SSRF): solo `https` y dominio `nubefact.com`; sin credenciales en la URL; sin redirecciones; las descargas de PDF/XML solo a hosts permitidos, con tope de 3 MB y 15 s.

## 3. Emisión

- **Automática**: si `autoIssue` está activo, cada cobro (caja, ludoteca, cuponera, mensualidad, reserva) genera una **boleta** a «CLIENTE VARIOS». El cajero puede elegir en el cobro (campo «Comprobante») boleta con DNI o factura con RUC.
- **Manual**: desde la página de la venta («Emitir comprobante»).
- Boleta: DNI de 8 dígitos si se informa; **desde S/ 700.00 el DNI es obligatorio**. Factura: RUC válido (11 dígitos, prefijo 10/15/16/17/20, dígito verificador), razón social y dirección.
- Los precios del sistema **incluyen IGV** (18 % configurable): se separa base e IGV por ítem sin perder céntimos. Un comprobante no admite líneas negativas: si la venta tiene cupón, canje de puntos o saldo de cuponera aplicado, se emite **una línea consolidada por el neto**.
- Una venta tiene como máximo un comprobante (`UNIQUE tenantId+saleId`). Una venta sin importe a pagar no genera comprobante.
- **La venta nunca se deshace por un fallo del comprobante**: el cobro se confirma primero; si algo falla se muestra un aviso y el comprobante queda pendiente.
- Numeración: correlativo por serie dentro de la misma transacción que crea el comprobante (sin saltos ni duplicados; probado con 6 emisiones simultáneas).

## 4. Estados, reintentos y errores

`PENDING` (por enviar/confirmar) → `ACCEPTED` | `REJECTED` | `FAILED`.

- Fallo de red/timeout/5xx/credenciales o SUNAT caído → `PENDING` con espera creciente: 1, 5, 15 min, 1, 3, 6, 12 h; tras 8 intentos → `FAILED` (reintento manual).
- Rechazo de SUNAT o error de validación del PSE → `REJECTED` con código y mensaje visibles. Se **corrige y reenvía con el mismo número** (SUNAT no lo tiene registrado).
- Un reenvío primero **consulta** al PSE (por si el envío anterior sí llegó y se perdió la respuesta). Nubefact «ya existe» (23) también se resuelve consultando.
- Un solo envío a la vez por comprobante (reserva con vencimiento de 2 min): cron y botón no duplican.
- Cron `/api/cron/sunat` (`vercel.json`, cada 15 min, protegido con `CRON_SECRET`). **Atención: los planes Hobby de Vercel solo admiten crons diarios**; con Hobby cambiar a `0 16 * * *` o usar el botón «Reintentar pendientes ahora».

## 5. Notas de crédito

Total (no parcial) sobre un comprobante **aceptado**; una sola por comprobante (`UNIQUE tenantId+creditedDocumentId`, también bajo concurrencia). Series propias (`BC01`/`FC01`). Motivos: 01 anulación de la operación, 02 error en el RUC (solo facturas), 06 devolución total. Al aceptarse, el original queda «anulado». Solo OWNER/ADMIN (`sunat:manage`).

**Limitación importante**: el sistema **no tiene un flujo de anulación/devolución de ventas** (no existe en fases anteriores). La nota de crédito anula el comprobante ante SUNAT pero **no revierte** stock, saldo de cuponera, puntos, cupones ni dinero de la caja. Construir ese flujo operativo queda como decisión pendiente para el propietario del producto.

## 6. Interfaz

- `/settings/sunat` (OWNER): configuración, probar conexión, activar. Activar exige una prueba correcta.
- `/reports/invoices` (OWNER/ADMIN): contadores por estado, filtros, error visible por comprobante, «Reintentar pendientes ahora». Detalle con corrección/reintento, nota de crédito y descarga de PDF/XML guardados en la base (`/reports/invoices/[id]/file`, también RECEPTION con `sunat:issue`).
- Página de la venta: estado del comprobante o formulario para emitirlo.

## 7. Limitaciones conocidas

1. Nubefact no verificado contra el servicio real (ver sección 1).
2. Sin nota de débito, anticipos, detracciones, boletas con CE/pasaporte, ni moneda distinta de PEN.
3. Notas de crédito solo totales. Reservas: se factura el cobro recibido (adelanto/abono) como servicio, sin tratamiento tributario de anticipos.
4. El resumen diario de boletas lo gestiona el PSE; no se implementó localmente.
5. El mock es sin estado: `consult` siempre devuelve «no existe» (reenviar es idempotente).
6. Si el proceso se interrumpe entre confirmar la venta y crear el comprobante, la venta queda sin comprobante (se ve en su página y se emite a mano); no hay barrido automático de ventas sin comprobante.
7. La fecha de emisión es el día de creación del comprobante (Lima), no del cobro, si se emite después.
8. El umbral de S/ 700 para DNI debe confirmarse con la norma vigente al activar la facturación real.
9. Migración `0013`: SQL escrito a mano (Prisma no genera CHECKs); equivalencia estructural comprobada por las pruebas remotas contra el cliente generado.

## 8. Fase 14 (pendientes cerrados aquí)

- `claude.md`: fórmula `expectedCash = openingBalance + cashSales - cashRefunds - cashExpenses`.
- Tope de gasto del cajero configurable por establecimiento: `Tenant.cashierExpenseLimitCents` (S/ 100.00 por defecto; CHECK 0–S/ 10,000.00), editable solo por el propietario en `/expenses`, auditado (`expense.cashier_limit`), aplicado en el servidor.
