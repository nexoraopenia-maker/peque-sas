# CLOUD_CODE.md

# PEQUESSAAS V3 --- CLOUD ARCHITECTURE & DEVELOPMENT GUIDE

**Producto:** PequesSaaS\
**Tipo:** SaaS B2B multi-tenant\
**Mercado inicial:** Perú\
**Arquitectura:** Next.js + Turso (libSQL/SQLite) + Prisma\
**Infraestructura:** Vercel\
**Estado:** Especificación técnica para desarrollo

------------------------------------------------------------------------

## 1. Instrucciones generales para el agente

Actúa como Principal Software Architect y Senior Full-Stack Engineer
responsable del desarrollo de PequesSaaS.

Este documento establece las reglas técnicas obligatorias del proyecto.

Antes de modificar código:

1.  Inspeccionar el repositorio.
2.  Revisar la arquitectura existente y `package.json`.
3.  Revisar `prisma/schema.prisma`.
4.  Identificar modelos, relaciones y funcionalidades existentes.
5.  Evitar duplicar implementaciones.
6.  No eliminar funcionalidades existentes sin autorización.
7.  Documentar decisiones arquitectónicas importantes.

Distinguir siempre entre funcionalidades diseñadas, en desarrollo,
implementadas, probadas y operativas en producción. No simular
integraciones externas ni declarar una funcionalidad terminada sin
pruebas.

## 2. Stack tecnológico

### Frontend

-   Next.js App Router.
-   TypeScript estricto.
-   Tailwind CSS.
-   shadcn/ui.
-   Diseño Dark Mode y responsive.

### Backend

-   Next.js Server Actions.
-   Route Handlers.
-   Servicios modulares en TypeScript.
-   Zod.
-   Autorización del lado servidor.

### Datos e infraestructura

-   Turso (libSQL / SQLite).
-   Prisma ORM.
-   Vercel para despliegue.
-   Vercel Cron para tareas programadas compatibles.
-   Almacenamiento de objetos compatible con S3 para documentos e
    imágenes.

### Integraciones

-   Meta WhatsApp Cloud API.
-   Proveedor PSE/OSE configurable para facturación electrónica.
-   Proveedor de IA configurable para el chatbot.

**No utilizar n8n, Supabase ni Railway.**

## 3. Estructura de referencia

Adaptar esta estructura al repositorio real; no duplicar carpetas o
funcionalidades existentes.

``` text
pequessaas/
├── app/
│   ├── (marketing)/
│   │   ├── page.tsx
│   │   └── register/
│   ├── (dashboard)/
│   │   ├── dashboard/
│   │   ├── families/
│   │   ├── playground/
│   │   ├── daycare/
│   │   ├── teachers/
│   │   ├── reservations/
│   │   ├── parent-portal/
│   │   ├── cash-register/
│   │   ├── products/
│   │   ├── subscriptions/
│   │   ├── reports/
│   │   └── whatsapp/inbox/
│   ├── settings/
│   │   ├── whatsapp/
│   │   └── sunat/
│   ├── superadmin/dashboard/
│   └── api/webhooks/whatsapp/
├── actions/
├── components/
│   ├── ui/
│   ├── dashboard/
│   ├── playground/
│   ├── daycare/
│   ├── reservations/
│   └── whatsapp/
├── lib/
│   ├── auth/
│   ├── db/
│   ├── rbac/
│   ├── validation/
│   ├── whatsapp/
│   ├── reservations/
│   ├── security/
│   ├── notifications/
│   └── utils/
├── prisma/schema.prisma
├── types/
├── hooks/
├── public/
├── tests/
├── docs/
├── middleware.ts
├── .env.example
├── CLOUD_CODE.md
└── package.json
```

## 4. Infraestructura cloud

### Turso (libSQL / SQLite)

Turso será el proveedor principal de base de datos.

Configurar: - Bases de datos separadas para desarrollo y producción, cada
una con su propio token. - Acceso desde la aplicación mediante
`@libsql/client` y `@prisma/adapter-libsql` con `TURSO_DATABASE_URL` y
`TURSO_AUTH_TOKEN`. - Migraciones: Prisma CLI solo opera sobre `file:`;
el SQL se genera con `prisma migrate diff` y se aplica a Turso con un
script, revisándolo antes. - Backups y estrategia de recuperación
(puntos de restauración de Turso). - Respetar las limitaciones de SQLite:
sin listas escalares (usar `Json`), sin `@db.*` nativos, importes en
céntimos (`Int`) y no en `Decimal`.

No utilizar la base de desarrollo en producción.

### Vercel

Vercel alojará: - Aplicación Next.js. - Route Handlers. - Server
Actions. - Endpoints de webhooks.

Configurar entornos Development, Preview y Production. Las tareas
programadas deben ser idempotentes y estar protegidas mediante
`CRON_SECRET`. No asumir que una función serverless permanecerá
ejecutándose indefinidamente.

## 5. Variables de entorno

Crear `.env.example`:

``` env
TURSO_DATABASE_URL=
TURSO_AUTH_TOKEN=

AUTH_SECRET=
APP_URL=

CRON_SECRET=

META_APP_ID=
META_APP_SECRET=
META_VERIFY_TOKEN=
META_API_VERSION=
```

Las credenciales específicas de cada establecimiento deben almacenarse
cifradas o en un gestor de secretos. Nunca enviar secretos al navegador
ni incluir credenciales reales en el repositorio.

## 6. Multi-tenancy

Cada establecimiento representa un tenant independiente.

Reglas obligatorias:

1.  Obtener `tenantId` desde la sesión autenticada; no confiar en el
    valor enviado por el navegador.
2.  Validar la pertenencia de cada registro al tenant.
3.  Aplicar filtros de tenant en las consultas correspondientes.
4.  Verificar relaciones entre entidades para evitar referencias
    cruzadas.
5.  Registrar operaciones administrativas sensibles.
6.  Centralizar helpers como `getCurrentUser()`, `getCurrentTenant()`,
    `requireRole()`, `requireTenantAccess()` y `requirePermission()`.

El rol no sustituye la validación de propiedad del recurso. Todas las
Server Actions y Route Handlers deben autorizar en servidor.

## 7. Autenticación y RBAC

Roles:

``` ts
type Role =
  | "SUPERADMIN"
  | "OWNER"
  | "ADMIN"
  | "RECEPTION"
  | "TEACHER";
```

Matriz inicial de permisos, ajustable mediante permisos granulares:

  Módulo          OWNER      ADMIN          RECEPTION                    TEACHER
  --------------- ---------- -------------- ---------------------------- --------------------
  Dashboard       Completo   Completo       Limitado                     Limitado
  Familias        Completo   Completo       Operativo                    Lectura autorizada
  Caja            Completo   Completo       Abrir/cerrar según permiso   No
  Reservas        Completo   Completo       Operativo                    Lectura asignada
  Playground      Completo   Completo       Operativo                    Según asignación
  Teacher Board   Completo   Completo       No                           Operativo
  WhatsApp        Completo   Configurable   Atención autorizada          No
  Configuración   Completo   Limitado       No                           No

SUPERADMIN debe operar mediante un contexto administrativo separado y
auditado.

## 8. Núcleo administrativo compartido

Disponible según el plan contratado.

### Dashboard

-   Ingresos y ventas del día.
-   Gastos.
-   Reservas.
-   Clientes registrados.
-   Niños presentes, cuando corresponda.
-   Pagos pendientes.
-   Actividad de trabajadores.
-   Indicadores de ocupación.
-   Resumen financiero.

### Clientes y familias

-   Padres y apoderados.
-   Teléfonos y correos.
-   Menores asociados.
-   Historial de visitas y compras.
-   Reservas, pagos y observaciones.

### Caja y finanzas

-   Apertura y cierre de caja.
-   Arqueo por trabajador.
-   Efectivo, Yape/Plin y tarjetas.
-   Registro de gastos, ingresos y egresos.
-   Historial y reportes.

### Trabajadores

-   Registro de empleados.
-   Roles y permisos.
-   Horarios y responsabilidades.
-   Historial de actividades y auditoría.

### Inventario

-   Productos e insumos.
-   Entradas y salidas.
-   Alertas de stock.
-   Compras y movimientos.

## 9. Módulos operativos independientes

PequesSaaS comparte infraestructura y administración, pero mantiene
separados los procesos de ludoteca y guardería. No reutilizar el flujo
de sesiones de ludoteca como sustituto de la asistencia de guardería.

### A. Ludotecas y centros de juegos

Ruta: `/playground`

-   Registro de ingreso y salida.
-   Identificación mediante pulseras.
-   Cronómetro basado en timestamps persistidos.
-   Tarifas por minutos, horas y servicios.
-   Semáforo: verde (tiempo disponible), amarillo (quedan cinco minutos)
    y rojo (tiempo excedido).
-   Cálculo de importes.
-   Control de aforo y capacidad.
-   Historial de sesiones y liquidaciones.
-   Cuponeras prepago.
-   Reservas y cumpleaños.
-   Alertas médicas, contactos de emergencia y personas autorizadas para
    recoger.
-   Registro de entrega del menor y de incidencias.

El cálculo de tiempo no debe depender de un cronómetro que se ejecute
permanentemente en el navegador.

### B. Guarderías

Ruta: `/daycare`

-   Matrículas y fichas infantiles.
-   Información médica, alergias y contactos de emergencia.
-   Asistencia y horarios de ingreso/salida.
-   Control de tardanzas.
-   Mensualidades y pagos.
-   Teacher Board táctil para tablets e iPads.
-   Registro de alimentación, siestas, higiene, cambios de pañal,
    actividades, estado de ánimo, observaciones e incidencias.
-   Reportes diarios a padres.
-   Fotografías únicamente con autorización y controles de privacidad.

Cada registro debe identificar al trabajador responsable y la hora. No
mostrar funciones exclusivas de otros módulos si el establecimiento no
las tiene contratadas.

## 10. Familias y seguridad infantil

Cada menor puede estar relacionado con uno o más apoderados autorizados.

Registrar: - Información básica. - Alergias y alertas médicas. -
Contactos de emergencia. - Autorizaciones y consentimientos. - Personas
autorizadas para recoger. - Historial de visitas e incidencias.

Aplicar controles estrictos a documentos, fotografías e información
sensible. Registrar quién realiza cada modificación. Los padres solo
podrán consultar menores asociados y autorizados.

## 11. Control de ludoteca y cuponeras

Ruta: `/playground/live`

Mostrar menores presentes, hora de entrada, tiempo transcurrido, tiempo
contratado, tiempo restante, estado e importe estimado.

Campo inicial de saldo:

``` prisma
prepaidMinutes Int @default(0)
```

Paquetes iniciales configurables: 300, 600 y 1200 minutos.

Registrar cada compra y consumo en un historial independiente; no
depender únicamente del saldo acumulado.

Las operaciones de compra, pago, consumo y cobro de excedentes deben ser
transaccionales e idempotentes. Prevenir saldos negativos y dobles
descuentos.

## 12. Caja y arqueo

Ruta: `/cash-register`

Registrar apertura de turno, sencillo inicial, ventas por método de
pago, efectivo declarado, diferencia, responsable y cierre.

Cálculos:

``` ts
difference = declaredCash - expectedCash;
expectedCash = openingBalance + cashSales - cashRefunds - cashExpenses;
```

`cashExpenses` son los gastos pagados con el efectivo físico del cajón durante el turno (Fase 14). Los pagos electrónicos no se suman al efectivo físico. Cada operación
financiera debe relacionarse con el turno correspondiente. El cierre
debe ser transaccional. Si el descuadre supera S/5, enviar una alerta al
propietario por WhatsApp cuando la integración esté configurada y
operativa.

## 13. Reservas y calendario

Ruta: `/reservations`

Vistas: día, semana, mes y agenda.

Tipos: ingreso a ludoteca, cumpleaños, eventos privados, celebraciones,
actividades y servicios de guardería cuando corresponda.

Cada reserva registra cliente, apoderado, menor, fecha, horario,
asistentes, servicio, precio, adelanto, saldo, estado y observaciones.

Estados: `PENDING`, `CONFIRMED`, `CANCELLED`, `COMPLETED`, `NO_SHOW`.

Funciones: - Disponibilidad real. - Control de capacidad y bloqueo de
horarios. - Asignación de espacios y trabajadores. - Adelantos y
saldos. - Confirmaciones y recordatorios. - Prevención de reservas
duplicadas mediante transacciones y restricciones apropiadas.

Cumpleaños y eventos deben permitir configurar paquetes, decoración,
alimentos, invitados, servicios adicionales, duración, pagos y checklist
de preparación.

## 14. Portal para padres

Ruta: `/parent-portal`

Permitir consultar: - Información de sus hijos. - Reservas y próximas
actividades. - Historial de visitas. - Pagos y deudas. - Saldo de
cuponeras. - Asistencia y reportes diarios. - Comunicaciones. -
Documentos y consentimientos.

La asociación entre la cuenta del padre y cada menor debe verificarse en
servidor. Nunca permitir acceso a información de otros menores.

## 15. WhatsApp Meta Cloud API

Ruta: `/settings/whatsapp`

Cada establecimiento conectará su propio número de WhatsApp Business. No
utilizar un único número centralizado para todos los tenants.

Configurar por establecimiento: - Meta App ID y App Secret cuando
corresponda. - Access Token. - Phone Number ID. - WABA ID. - Verify
Token. - Webhook. - Versión de API.

Crear un asistente de configuración que documente Meta Business
Portfolio, cuenta de desarrollador, aplicación, producto WhatsApp, WABA,
número, permisos, tokens, webhooks, plantillas y requisitos de
producción. Verificar los requisitos aplicables en la documentación
oficial vigente de Meta; no asumir que todos los negocios tienen
idéntico proceso.

Separar cliente API, autenticación, envío, recepción, webhooks,
plantillas, archivos, estados y errores. Validar la firma de cada
webhook y procesar mensajes de forma idempotente.

## 16. Chatbot personalizable

Ruta: `/settings/whatsapp/bot`

Controles: - Activación y desactivación global. - Activación por
conversación. - Pausa y transferencia a atención humana. - Personalidad,
tono e instrucciones. - Servicios, precios, horarios, preguntas
frecuentes y políticas. - Mensajes de bienvenida y fuera de horario.

El bot podrá responder consultas, informar servicios, consultar
disponibilidad, gestionar solicitudes de reserva y derivar a
trabajadores.

Debe consultar datos reales. Nunca inventar precios, disponibilidad ni
confirmaciones. Una reserva solo se confirma después de verificar y
guardar correctamente la operación.

Cuando un trabajador tome una conversación, el bot debe dejar de
responder en ese chat hasta su reactivación. El apagado global debe
impedir todas las respuestas automáticas del establecimiento.

## 17. WhatsApp Inbox

Ruta: `/whatsapp/inbox`

Interfaz de tres paneles:

1.  Lista de conversaciones.
2.  Conversación activa e historial.
3.  Información del cliente, menores asociados, reservas, visitas, pagos
    y notas internas.

Funciones: - Mensajes de texto y archivos. - Historial. - Estados de
entrega/lectura cuando Meta los proporcione. - Asignación y
transferencia. - Notas internas. - Bot ON/OFF por conversación. -
Atención humana y cierre.

Registrar mensajes entrantes y salientes. Mostrar claramente si responde
el bot o una persona.

## 18. Fidelización y marketing

Ruta: `/marketing`

-   Clientes frecuentes.
-   Historial de compras.
-   Puntos de fidelización.
-   Cupones y descuentos.
-   Promociones y campañas.
-   Segmentación de clientes.

Los mensajes comerciales por WhatsApp deben respetar autorizaciones,
preferencias y políticas aplicables.

## 19. Gastos y reportes

Ruta: `/reports`

Reportes de ingresos, egresos, gastos operativos, alquiler, servicios,
compras, nómina, ventas, ocupación, clientes recurrentes, servicios más
vendidos y rendimiento por trabajador.

Permitir filtros por fechas y exportación. Distinguir ingresos, cobros y
utilidad; no presentar cifras financieras incorrectas.

## 20. Pensiones y SUNAT

### Suscripciones

Ruta: `/subscriptions`

-   Mensualidades.
-   Vencimientos.
-   Pagos y deudas.
-   Recordatorios.
-   Historial.

### Facturación

Ruta: `/settings/sunat`

Preparar integración mediante proveedor PSE/OSE configurable: - Boletas
y facturas. - Notas de crédito y débito. - IGV. - Datos DNI/RUC. - PDF,
XML y estados.

No declarar integración operativa hasta comprobar emisión, aceptación y
consulta de comprobantes reales.

## 21. SuperAdmin y cuentas demo

Ruta: `/superadmin/dashboard`

Gestionar establecimientos, planes, suscripciones, activación,
suspensión, reactivación, integraciones y estadísticas.

### Generación de demos

Formulario: - Nombre comercial. - Tipo de negocio. - Correo
empresarial. - Nombre del administrador. - Contraseña temporal generada
automáticamente o definida por el administrador autorizado. - Plan
demo. - Módulos habilitados. - Fecha de vencimiento. - Límites
configurables.

Generar contraseñas seguras, almacenarlas mediante hash y mostrarlas una
sola vez. Solicitar cambio en el primer ingreso. Ofrecer
restablecimiento seguro. Las demos deben utilizar datos ficticios, nunca
datos reales de clientes.

El soporte administrativo debe estar autorizado, ser visible y quedar
auditado. No acceder innecesariamente a información privada de menores.

## 22. Planes y suscripciones SaaS

Cada plan define módulos, usuarios, establecimientos, almacenamiento,
WhatsApp, automatizaciones y reportes.

Comprobar límites y permisos en servidor. Cambiar de plan no debe
eliminar datos históricos. La suspensión debe ser controlada y respetar
las obligaciones contractuales y de conservación de datos.

## 23. Privacidad y seguridad

Aplicar la Ley peruana 29733 y su reglamentación vigente, además de las
obligaciones aplicables a datos personales de menores.

Implementar: - Consentimiento informado. - Acceso restringido. - Cifrado
de credenciales. - Gestión segura de documentos. - Auditoría. - Política
de retención y eliminación. - Gestión de solicitudes de titulares. -
Protección de información infantil en logs y URLs.

## 24. Metodología de desarrollo por fases

1.  Auditoría del repositorio.
2.  Turso y Vercel.
3.  Prisma y multi-tenancy.
4.  Autenticación y RBAC.
5.  Núcleo administrativo.
6.  Módulo de ludoteca.
7.  Módulo de guardería.
8.  Caja y cuponeras.
9.  Reservas y calendario.
10. Portal para padres.
11. WhatsApp Meta Cloud API.
12. Chatbot e Inbox.
13. Marketing y fidelización.
14. Gastos y reportes.
15. SUNAT.
16. SuperAdmin y demos.
17. Planes comerciales.
18. Pruebas y despliegue.

Antes de cada fase, inspeccionar código, dependencias, esquema y
conflictos. Después de cada fase, ejecutar validaciones TypeScript,
pruebas, validación Prisma, comprobaciones de permisos y aislamiento
multi-tenant, revisar logs y documentar resultados.

No avanzar si existen errores críticos de seguridad o integridad de
datos. No ejecutar migraciones destructivas sin autorización y respaldo.

## 25. Criterios de aceptación

Una fase solo se considera terminada cuando: 1. El código está
implementado. 2. Las validaciones pasan. 3. Las pruebas correspondientes
pasan. 4. Los permisos funcionan. 5. El aislamiento entre tenants está
comprobado. 6. Los errores pendientes están documentados. 7. Las
integraciones externas han sido verificadas cuando corresponda.

## 26. Objetivo final

Construir PequesSaaS como una plataforma SaaS B2B profesional para
negocios infantiles en Perú.

El propietario debe controlar su establecimiento; los trabajadores deben
operar fácilmente; los padres deben recibir información confiable; y los
menores deben contar con mecanismos adecuados de seguridad y protección.

**PEQUESSAAS: administra, automatiza y controla tu centro infantil desde
un solo lugar.**
