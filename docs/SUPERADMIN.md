# Fase 16 — SuperAdmin, gestión de establecimientos y cuentas demo

## 1. Modelo de seguridad (aislado de los roles de establecimiento)
- `SUPERADMIN` es un rol **global** (`User.tenantId = NULL`). Triggers en la base de datos (migración 0014) garantizan: SUPERADMIN nunca pertenece a un establecimiento, el resto de roles siempre sí, y **el rol no se puede asignar ni quitar con UPDATE** (anti escalada de privilegios). La única vía de creación es `npm run superadmin:create -- correo "Nombre"` (genera la contraseña, la imprime una sola vez, exige cambiarla al ingresar y registra `superadmin.bootstrap`). La interfaz web y `workerSchema` no pueden crear SUPERADMIN ni OWNER.
- **Capas** (cada una por sí sola bloquea a un OWNER de establecimiento):
  1. `proxy.ts`: para `/superadmin/*` verifica la **firma** del JWT y la marca `sa`; sin cookie → `/login`; token válido sin `sa` → **404**.
  2. `requireSuperAdmin()` en el layout, cada página y cada Server Action: rol SUPERADMIN + sin establecimiento + marca `sa` en la sesión + contraseña ya cambiada; si no, 403.
  3. Cada función de `lib/superadmin/*` vuelve a verificar en la base que el actor sea un SUPERADMIN activo (`assertSuperAdmin`). Una prueba estática impide que se añada una acción o función sin su guardia y que código ajeno importe el servicio.
- La marca `sa` solo se emite en `loginAction`/`changePasswordAction` a un usuario SUPERADMIN global. La sesión de SuperAdmin dura **2 h** (8 h la de establecimientos). `sessionVersion` la invalida.
- El panel solo muestra **agregados y metadatos de cuenta** (conteos, no nombres de menores ni de familias): soporte sin acceso innecesario a datos infantiles (claude.md §21).
- Toda acción deja `AuditLog` `superadmin.*` con el `tenantId` afectado y el actor (nunca se guarda una contraseña).

## 2. Panel `/superadmin/dashboard`
- **Métricas globales**: establecimientos por estado (activos, demos vigentes, demos vencidas, suspendidos); tokens de IA (`BotUsage`, entrada+salida, del mes y total) y respuestas del bot; transacciones (ventas y comprobantes electrónicos, del mes y total, aceptados y por reintentar); almacenamiento usado y establecimientos sobre su límite.
- **Establecimientos**: nombre, estado de suscripción (Activo/Demo/Demo vencida/Suspendido), plan, alta, vencimiento de demo, usuarios/límite, ventas y tokens del mes, almacenamiento/límite.
- **Detalle `/superadmin/tenants/[id]`**: usuarios (nombre, correo, rol, estado), conteos de uso, **suspender** (motivo obligatorio; cierra todas las sesiones), **reactivar** (vuelve a ACTIVE o DEMO), **cambiar de plan**, cambiar vencimiento de demo, **restablecer la contraseña del propietario** (temporal, se muestra una vez), historial de acciones de SuperAdmin.
- **Planes**: lista y alta (nombre, módulos, usuarios, almacenamiento, respuestas del bot, WhatsApp/automatizaciones/reportes).

Reglas: suspender impide el acceso (también en el login con mensaje claro); una **demo vencida** bloquea el acceso (los datos se conservan); cambiar de plan **no borra datos**, aplica los módulos del plan y se rechaza si el establecimiento tiene más usuarios activos que el nuevo plan permite; pasar de demo a plan normal quita el vencimiento y de normal a demo lo fija a 14 días.

## 3. Demos `/superadmin/demos/new`
Formulario: nombre comercial, tipo de negocio, correo y nombre del administrador, contraseña temporal (vacío = generada), plan demo propio (módulos, usuarios 3–20, almacenamiento, respuestas del bot, WhatsApp/automatizaciones), vencimiento (futuro, máx. 90 días, hasta el fin del día en hora de Lima).
En **una sola transacción** crea: plan demo, establecimiento `DEMO`, administrador (OWNER) + empleados (recepción, profesora, administración, hasta el límite de usuarios), 8 familias ficticias (apoderados y menores «(demo)», teléfonos 9000000xx, DNI 0000xxxx), 8 productos de POS, y según módulos: 3 tarifas de ludoteca, cuponeras 300/600/1200 min, 2 espacios de reserva y 3 matrículas de guardería. Contraseñas con hash, mostradas **una sola vez**; todos los usuarios deben cambiarla al ingresar. Un correo repetido o una entrada inválida no deja residuos.

## 4. Limitaciones y decisiones pendientes
1. **No hay alta de establecimientos reales** (solo demos): el producto aún carece de registro/onboarding de clientes pagos. Decisión pendiente.
2. **Sin cobros SaaS**: «estado de suscripción» = estado operativo (activo/demo/suspendido); no existe facturación ni pasarela de pago de la suscripción.
3. Sin **impersonación** ni «entrar como» un establecimiento (decisión deliberada: soporte sin acceso a datos de menores).
4. Sin **eliminación** de demos ni de establecimientos (destructivo; requiere autorización y respaldo). Una demo vencida queda bloqueada, no borrada.
5. Almacenamiento = PDF/XML de comprobantes guardados (no hay aún otros archivos ni fotos). No mide el tamaño de las filas de la base.
6. Los tokens de IA son los registrados por el chatbot; no incluyen otros consumos.
7. Sin 2FA para el SuperAdmin, sin lista de IPs permitidas ni límite de intentos distinto del general (5 fallos → bloqueo de 15 min). Recomendado antes de producción.
8. El **límite de 2 h** de sesión no renueva por actividad: hay que volver a iniciar sesión.
9. La migración 0014 está escrita a mano (Prisma no genera triggers); verificada por las pruebas remotas.
