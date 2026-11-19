# Fase 14 — Gastos, egresos y reportes financieros

Estado: **implementada y probada contra Turso real** (pruebas remotas, unitarias y HTTP). Los reportes y la exportación se calculan con datos reales del establecimiento; no hay integraciones externas en esta fase.

## 1. Categorías y origen del pago
| Categoría | Etiqueta |
|---|---|
| `OPERATING_SUPPLIES` | Operativos / Insumos |
| `PERSONNEL` | Personal |
| `RENT_UTILITIES` | Alquiler / Servicios |
| `MARKETING_MISC` | Marketing / Varios |

| Origen (`source`) | Efecto en caja |
|---|---|
| `CASH_DRAWER` | Efectivo del cajón: **obligatoriamente ligado al turno abierto**; baja el efectivo esperado |
| `CASH_OTHER`, `YAPE_PLIN`, `CARD`, `TRANSFER` | No tocan la caja; no necesitan turno |

Todo gasto lleva `tenantId` (siempre de la sesión), responsable, hora de registro y día contable (hora de Lima). Un CHECK en BD exige turno **si y solo si** el origen es `CASH_DRAWER`.

## 2. Decisión sobre el efectivo esperado
`claude.md` define `expectedCash = openingBalance + cashSales − cashRefunds`. Como un gasto pagado del cajón saca dinero físico, la fórmula implementada es:

`expectedCash = openingBalance + cashSales − cashRefunds − cashExpenses`

(`cashExpenses` = `CashRegisterSession.cashExpensesCents`). El arqueo, la diferencia y la alerta de descuadre > S/ 5.00 siguen igual. **`claude.md` no se modificó**: si apruebas esta ampliación conviene reflejarla allí.

## 3. Roles
| Acción | OWNER / ADMIN | RECEPTION (cajero) | TEACHER |
|---|---|---|---|
| Registrar gastos (`expenses:record`) | Cualquier categoría, origen, monto y fecha (no futura, ≤ 366 días atrás) | Solo **Operativos/Insumos**, **efectivo del cajón**, **hasta S/ 100.00** por gasto, fecha de hoy | No |
| Ver gastos | Todos, con filtros | Solo los de su turno abierto | No |
| Anular gastos (`expenses:manage`) | Sí, con motivo | No | No |
| Reportes y exportación (`reports:view`) | Sí | No (403) | No |

El tope del cajero (`CASHIER_LIMIT_CENTS`) es una constante en `lib/expenses/pure.ts`. Un cajero que manipula el formulario (otra categoría, origen, monto o fecha) es rechazado en el servidor.

## 4. Atomicidad e integridad
- El gasto del cajón se registra en **una transacción**: una sentencia condicionada (`UPDATE … WHERE turno abierto AND efectivo disponible ≥ monto`) suma al turno y luego se inserta el gasto. Cinco gastos simultáneos no pueden dejar el cajón en negativo (probado: de 5 × S/ 30 con S/ 100 solo caben 3).
- Si algo falla se revierte todo. El cierre de caja relee los totales **después** de marcar el turno como cerrado, así que ningún gasto puede colarse sin contarse.
- Idempotencia: `idempotencyKey` único por establecimiento (doble envío, incluso simultáneo = un gasto).
- Los gastos **no se borran**: se anulan con motivo. Un gasto del cajón solo se anula mientras su turno siga abierto (devuelve el efectivo); si el turno ya está cerrado se rechaza porque ya fue arqueado. Los demás se anulan siempre.

## 5. Reportes (`/reports`, solo OWNER/ADMIN)
Rango de fechas (máx. 366 días) y desglose **diario, semanal (lunes a domingo) o mensual**; atajos Hoy / Esta semana / Este mes / Últimos 90 días. Los periodos sin movimiento aparecen en cero y la suma de los periodos siempre es igual al total.

Criterios (base caja):
- **Ingresos** = ventas cobradas en el periodo (ya netas de cupones y puntos; se muestran los descuentos otorgados aparte). Todo cobro es inmediato, así que cobros = ingresos.
- **Egresos** = gastos vigentes (no anulados) por su fecha contable.
- **Utilidad** = ingresos − egresos; **margen** = utilidad / ingresos (en puntos básicos enteros; sin ingresos no hay margen).
- Las **mensualidades pendientes** se muestran como “por cobrar” y **no** son ingreso hasta cobrarse.
- Desgloses: ingresos por tipo y por medio de pago; egresos por categoría y por origen. Los días se cortan en hora de Lima (UTC-5, sin horario de verano).

## 6. Exportación
`GET /reports/export?type=summary|expenses&format=csv|pdf&from=YYYY-MM-DD&to=YYYY-MM-DD&g=DAY|WEEK|MONTH` (solo OWNER/ADMIN; el establecimiento sale de la sesión, nunca de la URL; 401 sin sesión, 403 sin permiso, 400 con parámetros inválidos; `Cache-Control: no-store`; cada descarga queda auditada).
- **CSV**: UTF-8 con BOM (Excel), CRLF, importes decimales exactos, texto con forma de fórmula (`=`, `+`, `-`, `@`) neutralizado contra inyección; los importes negativos (pérdidas) se conservan intactos.
- **PDF**: generado por código propio (sin dependencias nuevas: PDF 1.4, Courier, A4 paginado). Es un informe de texto tabulado, **sin gráficos**.

## 7. Pantallas
`/expenses` (formulario, listado, filtros, anulación, exportación de detalle), `/reports` (KPIs, tabla por periodo, desgloses, descargas), formulario “Gasto del turno” y tarjeta “Gastos del cajón” en `/cash-register`.

## 8. Limitaciones conocidas
1. Reportes en **base caja**, no devengado: no hay prorrateo de gastos anuales ni de cuponeras (los minutos se reconocen como ingreso al venderse).
2. Sin presupuestos, gastos recurrentes, adjuntos de comprobantes, proveedores como catálogo ni impuestos (IGV); “proveedor” y “referencia” son texto libre.
3. No hay devoluciones a clientes (`cashRefundsCents` sigue en 0), por lo que no restan de los ingresos.
4. Los gastos no se editan (se anulan y se vuelven a registrar).
5. El PDF no incluye gráficos; el rango es de 366 días como máximo; el reporte lee hasta 200 000 ventas por consulta.
6. El tope del cajero (S/ 100.00) es fijo, no configurable por establecimiento.
7. La nómina de **Personal** es solo un gasto etiquetado; no hay módulo de planilla.
8. Un solo turno de caja abierto por establecimiento (como en la Fase 8): los gastos del cajón se ligan a ese turno.
9. La paridad de la migración `0012` con el esquema de Prisma se comprobó leyendo el SQL generado por `prisma migrate diff` (la opción `--from-url` ya no existe en esta versión de Prisma).
