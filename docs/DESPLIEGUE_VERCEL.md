# Despliegue en Vercel — PequesSaaS (producción)

> Estado: la aplicación compila y pasa todas las pruebas automatizadas (ver `docs/PROGRESO.md`). Lo que **no** se puede comprobar sin credenciales reales y por eso está marcado como *pendiente de verificación en producción*: emisión real con Nubefact, cobros reales con Mercado Pago, WhatsApp de Meta con un número real, y el chatbot con la clave de Anthropic.

## 0. Plan de Vercel (decisión que debes tomar)
- **Vercel Hobby es solo para uso no comercial** (sus términos); un SaaS B2B que cobra suscripciones requiere **Pro**.
- **Hobby** solo admite crons **una vez al día**. `vercel.json` ya está en modo seguro para Hobby (todos los crons diarios) para que el despliegue nunca falle.
- **Pro**: copia `vercel.pro.json` sobre `vercel.json` (`cp vercel.pro.json vercel.json`). La única diferencia: el reintento de comprobantes SUNAT corre cada 15 minutos en vez de una vez al día.
- Crons configurados (UTC; Lima = UTC−5): `billing` 13:00 (08:00 Lima), `reservation-reminders` 14:00, `marketing` 15:00, `sunat` 16:00 (o cada 15 min en Pro). Todos exigen `Authorization: Bearer $CRON_SECRET` (Vercel lo envía solo) y son idempotentes.
- Las funciones se despliegan en `iad1` (Virginia), la misma región que la base Turso `aws-us-east-1`: menor latencia a la base. Si creas la base de producción en otra región, cambia `regions` en `vercel.json`.

## 1. Base de datos de producción (Turso)
1. Crea una base **nueva para producción** (no reutilices la de desarrollo) y un token propio:
   `turso db create peque-sas-prod --location aws-us-east-1` · `turso db tokens create peque-sas-prod`.
2. Aplica las migraciones a producción (revisa antes el SQL; son aditivas, no destructivas):
   `TURSO_DATABASE_URL=… TURSO_AUTH_TOKEN=… node scripts/db-migrate.mjs --status` y luego sin `--status`.
   El script es transaccional por migración, registra checksums y se niega a continuar si una migración ya aplicada fue modificada.
3. Respaldo: activa los puntos de restauración de Turso (point-in-time) y anota cómo restaurar (`turso db create … --from-db … --timestamp …`) antes de abrir a clientes. No ejecutes migraciones destructivas sin respaldo.

## 2. Variables de entorno
Define cada variable en Vercel → Settings → Environment Variables, **por entorno** (Production / Preview / Development). Referencia completa y comentada: `.env.example`. Tipadas y validadas en `lib/env.ts`.

| Variable | Obligatoria | Para qué |
|---|---|---|
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Sí | Base de datos (producción ≠ desarrollo) |
| `AUTH_SECRET` | Sí (≥ 32) | Sesiones y cifrado de credenciales por establecimiento. **Si se rota hay que volver a guardar credenciales de WhatsApp/SUNAT y se cierran todas las sesiones** |
| `APP_URL` | Sí (https) | Webhooks, retorno de pagos |
| `CRON_SECRET` | Sí (≥ 16) | Protege `/api/cron/*` y el detalle de `/api/health` |
| `ANTHROPIC_API_KEY` | Para el chatbot | Sin ella el bot deriva a una persona. `ANTHROPIC_MODEL`/`ANTHROPIC_EFFORT` opcionales |
| `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_API_VERSION` | Para WhatsApp compartido | Ver `docs/WHATSAPP_META_SETUP.md`. `META_GRAPH_BASE_URL` solo para pruebas |
| `PAYMENT_PROVIDER` | Sí | `NONE` (solo pagos manuales), `MERCADOPAGO` en producción. **`MOCK` está prohibido en producción** |
| `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET` | Con `MERCADOPAGO` | Cobro en línea y verificación de la firma de avisos |
| `BILLING_MANUAL_INSTRUCTIONS` | Recomendada | A qué Yape/Plin/cuenta deben pagar los propietarios |

Verificación **sin mostrar valores**: `npm run env:check` (usa `.env.local`) o, para producción, `NODE_ENV=production node --env-file=<archivo> scripts/env-check.ts`. En producción además valida: base no local, `APP_URL` https, sin `MOCK`, secretos de Mercado Pago presentes. Al arrancar, `instrumentation.ts` registra en los logs los errores de configuración (nunca valores).

## 3. Despliegue
1. Repositorio: `.gitignore` ya excluye `.env*` (salvo `.env.example`), `.vercel` y `lib/generated`. Verifica con `git status` que no hay secretos antes de subir.
2. Importa el repositorio en Vercel (Framework: Next.js; el comando de build ya ejecuta `prisma generate && next build`; Node 22 o 24).
3. Configura las variables (sección 2) y despliega. Asigna tu dominio y verifica que `APP_URL` coincide.
4. Si usas Pro: `cp vercel.pro.json vercel.json` antes del despliegue.

## 4. Puesta en marcha (una sola vez)
1. **Crear el SuperAdmin de producción** (única vía; la contraseña se muestra una sola vez y debes cambiarla al ingresar):
   `TURSO_DATABASE_URL=… TURSO_AUTH_TOKEN=… node scripts/create-superadmin.mjs tu-correo@empresa.com "Tu Nombre"`.
2. Entra a `/superadmin/dashboard`, crea los **planes** (precio, límites, módulos) y asigna plan a cada establecimiento. Los planes de pago generan suscripción con 7 días de prueba y luego cobro automático.
3. **Pagos**: con `MERCADOPAGO`, en el panel de Mercado Pago configura la notificación (webhook) a `https://TU-DOMINIO/api/webhooks/payments/mercadopago` con el evento *Pagos* y copia su clave secreta a `MERCADOPAGO_WEBHOOK_SECRET`. Sin pasarela, los propietarios reportan Yape/Plin/transferencia y tú confirmas en el detalle del establecimiento.
4. **WhatsApp**: sigue `docs/WHATSAPP_META_SETUP.md`; el webhook es `https://TU-DOMINIO/api/webhooks/whatsapp`.
5. **SUNAT**: cada propietario configura su PSE en `/settings/sunat`. Antes de emitir con clientes reales, verifica Nubefact con una cuenta demo (ver `docs/SUNAT_FACTURACION.md`).

## 5. Verificación posterior al despliegue (humo)
- `GET /api/health` → `{"status":"ok"}`. Con `Authorization: Bearer <CRON_SECRET>` devuelve además el resultado de la validación de entorno (sin valores) y la versión de Node.
- Un cron manual: `curl -H "Authorization: Bearer $CRON_SECRET" https://TU-DOMINIO/api/cron/billing` → JSON con `checked`; sin el encabezado → 401.
- Inicia sesión como SuperAdmin; `/superadmin` con un usuario normal → 404.
- Crea una demo desde `/superadmin/demos/new`, entra con sus credenciales y comprueba que pide cambiar la contraseña.
- Revisa los logs de Vercel: no debe aparecer `[env] configuración inválida`.

## 6. Operación
- **Impago**: el ciclo diario genera el cobro 7 días antes, marca vencida al terminar el periodo, da 5 días de gracia y luego bloquea (el propietario solo ve `/billing` para pagar; sus datos se conservan). Un pago reactiva automáticamente solo los bloqueos por impago; las suspensiones manuales las levanta el SuperAdmin.
- **Límites por plan**: usuarios activos, respuestas del chatbot por mes, almacenamiento de archivos y módulos (WhatsApp, SUNAT, Reportes, Automatizaciones) se validan en el servidor y se muestran al propietario en `/billing`.
- **Rollback**: Vercel permite promover un despliegue anterior al instante. Las migraciones son aditivas: no requieren revertirse para volver a una versión anterior del código.
- **Seguridad**: cabeceras HSTS, nosniff, anti-iframe y permisos restringidos en toda la app. No se define CSP estricta (Next.js inserta scripts en línea): es una mejora pendiente.

## 7. Lo que NO está verificado en producción real (declaración honesta)
Emisión de comprobantes con Nubefact · cobros reales con Mercado Pago · envío/recepción real con Meta WhatsApp · respuestas reales del chatbot con la clave de Anthropic · comportamiento del plan Hobby/Pro de Vercel (límites de cron y de duración) · rendimiento bajo carga real. Todo lo anterior se probó con dobles/servidores locales que reproducen el contrato; hacen falta pruebas de aceptación con credenciales reales (demo/sandbox de cada proveedor) antes de cobrar a clientes.
