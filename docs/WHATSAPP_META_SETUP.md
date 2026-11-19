# Guía de conexión: WhatsApp Cloud API (Meta) para PequesSaaS

> Lectura obligatoria antes de conectar un establecimiento. Los requisitos se verificaron en la documentación oficial de Meta
> el **2026-11-17** (fuentes al final). Meta cambia sus páginas con frecuencia: ante cualquier diferencia, **manda la documentación vigente**.
> Lo que no se pudo confirmar textualmente está marcado como **[NO CONFIRMADO]**.
>
> **Estado de esta integración:** el código está implementado y probado contra un servidor Graph simulado (pruebas automáticas) y contra
> Turso real. **No se ha probado todavía contra Meta con credenciales reales**: ese paso lo hace cada establecimiento con el botón
> «Probar conexión» de `/settings/whatsapp`. Hasta entonces no debe considerarse operativo en producción.

## 1. Modelo de conexión

- Cada establecimiento conecta **su propio número** (no existe un número central).
- Un número (`Phone Number ID`) solo puede pertenecer a **un** establecimiento.
- Hay **una URL de webhook única** para todo el sistema: `https://<APP_URL>/api/webhooks/whatsapp`. El sistema enruta cada evento por
  `metadata.phone_number_id` y solo lo acepta si lo firmó el App Secret **de ese establecimiento** (o el global `META_APP_SECRET`).
- Dos formas de usar apps de Meta (el propio sistema las admite a la vez):
  1. **App compartida** (recomendada para un SaaS): una sola app de Meta del proveedor; variables globales `META_APP_ID`, `META_APP_SECRET`,
     `META_VERIFY_TOKEN`. El establecimiento no ingresa App Secret.
  2. **App propia por establecimiento**: el dueño crea su app y pega su **App Secret** en el panel (se guarda cifrado).
- Webhook por WABA: el botón «Suscribir webhook» puede fijar la URL y el verify token **solo de ese WABA** (`override_callback_uri`,
  `verify_token`), que tiene prioridad sobre el webhook de la app. Requiere `APP_URL` con https.

## 2. Requisitos en Meta (en este orden)

1. **Meta Business Portfolio** (antes «Business Manager») del establecimiento. Para pasar del nivel inicial de mensajería (250 destinatarios
   únicos fuera de la ventana de 24 h en 24 h) conviene **verificar el negocio**.
2. **Cuenta de desarrollador** de Meta y una **App** de tipo *Business* asociada al portafolio. Agregar el producto **WhatsApp**.
3. **Cuenta de WhatsApp Business (WABA)** y **número de teléfono** registrado (con nombre visible aprobado). Anotar:
   - `Phone Number ID` (numérico) y `WABA ID` (numérico). **No** son el número de teléfono.
4. **Permisos** de la app/token:
   - `whatsapp_business_messaging` (enviar mensajes y recibir el webhook `messages`).
   - `whatsapp_business_management` (administrar la cuenta, plantillas, suscripción).
   - `business_management` (necesario para generar el token del usuario de sistema).
5. **Token permanente** (no usar el token temporal de la app: «expires quickly»):
   *Business Settings → Usuarios → Usuarios del sistema → Agregar → Asignar activos* (la **App** con control total / «Manage app» y la **cuenta de
   WhatsApp** con «Manage WhatsApp Business accounts») → **Generar token** marcando los 3 permisos anteriores. Pegarlo en `/settings/whatsapp`.
   **[NO CONFIRMADO]** la caducidad exacta de los tokens de usuario de sistema (las páginas leídas no la indican): comprobar al generarlo y,
   si caduca, programar su renovación.
6. **Webhook**: en el panel de la app → WhatsApp → Configuración → *Webhook*: URL de devolución de llamada y **Verify token** (ambos se
   copian desde `/settings/whatsapp`). Suscribir el campo **`messages`**. El panel también permite hacerlo con «Suscribir webhook».
7. **Plantillas** (obligatorias para escribir primero, ver §4): crearlas en *WhatsApp Manager → Plantillas de mensajes* y esperar el estado
   **APPROVED**. Solo se pueden enviar plantillas aprobadas.

## 3. Variables de entorno

| Variable | Uso |
|---|---|
| `AUTH_SECRET` | Deriva (HKDF) la clave de cifrado AES-256-GCM de las credenciales. **Si se rota, hay que volver a guardar token y App Secret de cada establecimiento.** |
| `APP_URL` | URL pública https (para el webhook por WABA y los enlaces). |
| `CRON_SECRET` | Protege `/api/cron/reservation-reminders` (Vercel Cron envía `Authorization: Bearer`). |
| `META_APP_SECRET` | App Secret global (app compartida). Opcional si cada tenant guarda el suyo. |
| `META_VERIFY_TOKEN` | Verify token global opcional (además del token único de cada tenant). |
| `META_API_VERSION` | Versión de Graph API (por defecto `v27.0`, la indicada como más reciente en la documentación). Cada tenant puede fijar la suya. |
| `META_GRAPH_BASE_URL` | Solo para pruebas/sandbox (por defecto `https://graph.facebook.com`). En producción debe ser https. |

## 4. Plantillas y ventana de 24 horas

- **Ventana de atención al cliente:** se abre 24 h cuando el usuario escribe al negocio y se reinicia con cada mensaje suyo. Dentro de la
  ventana se puede enviar **texto libre**; fuera, **solo plantillas aprobadas**. El sistema aplica esta regla antes de llamar a Meta
  (`OUTSIDE_WINDOW`) y nunca finge un envío.
- **Parámetros:** posicionales (`{{1}}`, `{{2}}`…). El sistema envía solo componentes `body` (y el botón en autenticación). Los parámetros no
  admiten saltos de línea ni espacios repetidos (se limpian).

Plantillas que usa el sistema (los nombres son configurables en el panel):

| Disparo | Categoría sugerida | Parámetros del cuerpo |
|---|---|---|
| Código de acceso del portal (`tplPortalCode`) | **Utilidad**: `{{1}}` código, `{{2}}` minutos de vigencia. O **Autenticación** | Utilidad: 2 · Autenticación: código en el cuerpo **y** en el botón |
| Recordatorio de reserva (`tplReservationReminder`) | Utilidad | `{{1}}` contacto, `{{2}}` fecha (AAAA-MM-DD), `{{3}}` hora, `{{4}}` saldo (ej. «S/ 30.00») |
| Alerta de caja (`tplCashAlert`) | Utilidad | `{{1}}` diferencia (ej. «-S/ 20.00»), `{{2}}` esperado, `{{3}}` contado, `{{4}}` fecha |

Ejemplo de texto de la plantilla de utilidad del portal:
`Tu código de acceso al portal de padres es {{1}}. Vence en {{2}} minutos y sirve una sola vez. No lo compartas.`

**Plantillas de autenticación con botón «copiar código»:** el envío lleva el código en el cuerpo y un componente
`{"type":"button","sub_type":"url","index":"0","parameters":[{"type":"text","text":"<código>"}]}` (así lo muestra la página oficial de
plantillas de autenticación con copiar código). **[NO CONFIRMADO]** en producción real: la documentación de ejemplos mezcla `index` como texto
(`"0"`) y como número (`0`) y distintas versiones de API; si Meta rechaza el envío, revisar el error `132000`/`132012` y ajustar. Las
plantillas de autenticación **no** se pueden enviar a usuarios identificados solo por BSUID (error 131062).

## 5. Qué dispara mensajes (solo con WhatsApp **activo**)

1. **Código del portal de padres** — (a) el personal lo genera en *Familias* y puede enviarlo por WhatsApp; (b) el apoderado lo pide solo en el
   login del portal. Siempre se envía **al teléfono registrado del apoderado**, nunca a un número escrito por quien lo solicita, y solo si se
   puede entregar (plantilla aprobada o ventana abierta). El código no se guarda en claro ni en el historial de mensajes.
2. **Recordatorios de reservas** — cron diario (`vercel.json`, 14:00 UTC = 09:00 Lima) para las reservas de **mañana** con teléfono de
   contacto, y botón manual en el detalle de la reserva. Cada recordatorio se *reclama* antes de enviarse: no hay duplicados.
3. **Alerta de caja** — al cerrar un turno con |diferencia| **mayor a S/ 5.00** se avisa al teléfono del propietario configurado. Un fallo
   del aviso nunca deshace el cierre; el estado se ve en *Caja* y en el historial de WhatsApp.

## 6. Seguridad implementada

- Webhook: validación de **`X-Hub-Signature-256`** (HMAC-SHA256 con el App Secret) sobre el cuerpo **crudo** antes de procesar, en tiempo
  constante. Meta documenta en Messenger que calcula la firma sobre la versión con **Unicode escapado**; el sistema acepta ambas variantes
  (solo si el HMAC coincide). **[NO CONFIRMADO]** textualmente para WhatsApp: la página de webhooks dice «payload»; verificar con un evento real.
- Cuerpo máximo 1 MB; firma ausente o inválida → 401 sin efectos; error interno → 500 (Meta reintenta; el proceso es idempotente).
- Idempotencia: `waMessageId` único por establecimiento; los estados de entrega solo avanzan (`SENT < DELIVERED < READ`).
- Credenciales cifradas (AES-256-GCM) con datos autenticados (`tenantId` + campo): un texto cifrado copiado a otro tenant no se descifra.
- El token solo se envía a Graph API y nunca aparece en errores, registros ni en el navegador (solo se muestran los 4 últimos caracteres).
- Los ids que se insertan en las rutas de Graph se validan (numéricos). La URL de descarga de archivos debe ser https y de un dominio de Meta.
- Los textos de los mensajes **recibidos** no se muestran en el panel (datos personales; los menores están especialmente protegidos por la Ley 29733).

## 7. Reintentos, límites y errores que conviene conocer

- Si el webhook falla, Meta reintenta. **[NO CONFIRMADO]** el plazo: una página dice hasta 36 horas y otra hasta 7 días.
- Códigos de error útiles (página oficial de errores): `131047` más de 24 h desde la última respuesta del usuario (usar plantilla),
  `132001` plantilla inexistente o no aprobada, `132000` número de parámetros distinto, `132012` formato de parámetro, `131026` mensaje no
  entregable, `190` token vencido/inválido, `4`/`80007`/`130429`/`131048`/`131056` límites de tasa o restricciones (se marcan reintentables).
- Archivos recibidos: se obtiene una URL temporal con `GET /{media-id}` (vence en **5 minutos**) y se descarga con el mismo token; los ids
  vencen a los 7 días (webhook). El sistema incluye la descarga (`downloadMedia`) pero **no guarda archivos**: no hay almacenamiento S3
  configurado todavía.
- Límites de mensajería: por portafolio, 250 → 2.000 → 10.000 → 100.000 → ilimitado (destinatarios únicos fuera de la ventana por 24 h).

## 8. Lista de comprobación para activar un establecimiento

1. [ ] Portafolio, app, WABA y número creados; `Phone Number ID` y `WABA ID` anotados.
2. [ ] Token permanente de usuario de sistema con los 3 permisos.
3. [ ] Plantillas creadas y **APPROVED** (portal, recordatorio, alerta de caja).
4. [ ] `/settings/whatsapp`: guardar credenciales y nombres de plantillas.
5. [ ] «Probar conexión con Meta» → correcta (el token lee el número y el número pertenece al WABA).
6. [ ] «Suscribir webhook» (o configurar la URL y el verify token en el panel de Meta) y suscribir el campo `messages`.
7. [ ] «Activar».
8. [ ] Enviar un mensaje desde un celular al número y comprobar que aparece en «Últimos mensajes».
9. [ ] Generar un código del portal con «Enviar por WhatsApp» y comprobar la entrega.

## Fuentes (Meta for Developers)

- Webhooks (verificación y firma): https://developers.facebook.com/docs/graph-api/webhooks/getting-started
- Estructura del webhook de WhatsApp: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components
- Envío de mensajes y ventana de 24 h: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages
- Plantillas: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview
- Plantillas de autenticación (copiar código): https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/authentication-templates/copy-code-button-authentication-templates
- Medios: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media
- Webhook por WABA / número (override): https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/override
- Códigos de error: https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes
- Versionado de Graph API: https://developers.facebook.com/docs/graph-api/guides/versioning
- Límites de mensajería: https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits
- Firma con Unicode escapado (Messenger): https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks
