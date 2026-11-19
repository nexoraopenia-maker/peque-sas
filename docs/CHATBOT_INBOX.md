# Chatbot e Inbox de WhatsApp (Fase 12)

> Estado: implementado y probado contra Turso real con **dobles** de la API de Meta y de la API de Claude (no hay credenciales reales de
> ninguna de las dos en este entorno). **Nunca se ha ejecutado contra Claude real**: la primera prueba con clave real es obligatoria antes
> de activar el bot en un establecimiento (ver §7).

## 1. Qué hace

- **Bot** (`lib/whatsapp/bot/`): responde por WhatsApp a las familias usando Claude con *herramientas de solo lectura* sobre los datos reales
  del establecimiento. Pasa a una persona cuando no tiene el dato, hay un reclamo o el cliente lo pide.
- **Inbox** (`/whatsapp/inbox`): tres paneles (conversaciones · chat con notas internas y archivos · ficha del cliente) para el personal.
- **Configuración** (`/settings/whatsapp/bot`, solo propietario): activar/desactivar, personalidad, políticas, horario, bienvenida,
  fuera de horario, mensaje de traspaso, preguntas frecuentes y servicios con precio.

## 2. Reglas que el bot no puede romper

| Regla | Cómo se garantiza |
|---|---|
| Solo responde con datos reales | Prompt + herramientas (`get_business_info`, `get_faqs`, `get_prices`, `check_availability`) que leen la base. Si no hay datos, la herramienta lo dice y el prompt manda derivar. |
| No inventa precios | **Verificación en código** antes de enviar: todo importe en soles debe aparecer en lo que devolvieron las herramientas o en los textos del propietario. No se calculan totales. |
| No inventa disponibilidad | Hablar de cupo exige haber llamado a `check_availability`, y no puede contradecir su resultado. |
| **Nunca confirma una reserva** | `request_reservation` crea una solicitud `PENDING`; el texto «confirmada/asegurada/te reservamos…» se bloquea. Solo el equipo confirma. |
| No filtra datos de menores ni de otros clientes | No existe ninguna herramienta que lea menores, saldos, deudas ni asistencia: se deriva al Portal de padres o a una persona. |
| No cruza establecimientos | `tenantId`, conversación y teléfono salen del servidor, **nunca** de los argumentos del modelo; ninguna herramienta tiene esos parámetros. |
| Resiste inyección de instrucciones | Los mensajes del cliente son turnos de usuario (datos). Se bloquean respuestas con enlaces o teléfonos que no vengan de los datos. |
| Se detiene cuando una persona toma el chat | Tomar, asignar, escribir o apagar el bot desactiva el bot de ESE chat al instante; justo antes de enviar se comprueba otra vez (si la IA tardó y una persona tomó el chat, **no se envía**). |

Si una verificación falla, la respuesta **no se envía**: se avisa al cliente con el mensaje de traspaso y la conversación queda marcada
«Necesita atención» con el motivo.

## 3. Flujo de un mensaje

1. El webhook (firma validada, idempotente) guarda el mensaje y devuelve **200 a Meta de inmediato**; el bot corre después (`after()`).
2. `runBot`: compuertas (bot activo, plan con automatizaciones, bot activo en el chat, chat abierto) → **bloqueo por conversación** (un solo
   procesador; los mensajes que llegan juntos se responden en una sola vez) → ¿pidió una persona? (sin IA) → ¿archivo/audio? (traspaso) →
   ¿fuera de horario? (mensaje una vez por día, sin IA) → límites (mensual del plan y por hora) → bienvenida (una vez) → bucle con el modelo
   (máx. 6 pasos) → verificación → compuerta final → envío.
3. Cada mensaje del cliente se marca como atendido (`botHandledAt`); los que llegan mientras se responde se atienden en la ronda siguiente.

## 4. Claude (IA)

- SDK oficial `@anthropic-ai/sdk` (única dependencia nueva: es el proveedor pedido; aporta reintentos, tiempos de espera y errores tipados).
- **Una clave global del sistema** (`ANTHROPIC_API_KEY`), administrada por el SuperAdmin. El consumo se absorbe en los planes:
  `Plan.botMonthlyReplies` (por defecto 300) y la tabla `BotUsage` (tokens por turno y establecimiento). El panel de SuperAdmin (Fase 16)
  gestionará la rotación de la clave y verá el consumo; hasta entonces la clave vive en la variable de entorno.
- Modelo `ANTHROPIC_MODEL` (por defecto `claude-opus-5-5`) y esfuerzo `ANTHROPIC_EFFORT` (por defecto `low`). **Decisión de costos del SuperAdmin:**
  un modelo más económico (p. ej. `claude-sonnet-5-5` o `claude-haiku-5-5`) reduce el costo; hay que medir la calidad antes de cambiarlo.
- Con Opus 5.5 el pensamiento está siempre activo (no se envía `thinking`); no se usa `temperature` ni `tool_choice` forzado.
- `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`): si los filtros de seguridad rechazan una solicitud, la API la reintenta con
  un modelo de respaldo; si aun así se rechaza (`stop_reason: "refusal"`), la conversación pasa a una persona. No se envía a modelos que no lo admiten.
- No se usa caché de prompts: el prompt del sistema es corto (por debajo del mínimo cacheable).

## 5. Inbox

- Filtros: abiertas, necesitan atención, mías, sin asignar, cerradas. Indicadores: Bot ON/OFF, asignado a, «Nuevo», «Necesita atención».
- Cada mensaje muestra quién lo escribió: Cliente, 🤖 Bot, 👤 persona o ⚙ Sistema; y su estado de entrega (✓, ✓✓, leído, falló).
- **Notas internas** en una tabla aparte (`ConversationNote`): no pueden mezclarse con los mensajes ni enviarse al cliente.
- Archivos enviados: JPG, PNG, PDF, MP3, OGG y MP4 con límites de tamaño y **verificación de la firma real del archivo** (un ejecutable o un
  PNG disfrazado de PDF se rechaza). Archivos recibidos: no se guardan; se piden a Meta al momento por una ruta autenticada con cabeceras
  `nosniff` + `sandbox`.
- Cerrar una conversación **reactiva el bot** para futuras consultas; un mensaje nuevo la reabre.
- Fuera de la ventana de 24 h solo se pueden enviar plantillas (regla de Meta): el inbox avisa y bloquea el texto libre.
- Permisos: `whatsapp:use` (propietario, administración, recepción) para la bandeja; `whatsapp:configure` (solo propietario) para el bot.

## 6. Limitaciones conocidas

- La verificación anti-alucinación es **heurística**: puede bloquear una respuesta válida (se deriva a una persona) y no detecta errores
  que no sean importes, confirmaciones, disponibilidad, enlaces o teléfonos (por ejemplo, un horario mal citado). El control principal sigue
  siendo que el bot solo disponga de herramientas de lectura.
- El bot no lee datos de menores ni de cuentas a propósito; las consultas personales se derivan al Portal de padres o a una persona.
- Las solicitudes de reserva del bot no se pueden editar (la edición de reservas no existe todavía): se cancelan y se vuelven a crear.
- No hay plantillas desde el inbox (solo texto y archivos dentro de la ventana de 24 h).
- El bot no interpreta audios, imágenes ni documentos: los pasa a una persona.
- Sin tiempo real: la bandeja se actualiza cada 20 s (no hay WebSockets).

## 7. Antes de activar un establecimiento (lista de comprobación)

1. [ ] Clave `ANTHROPIC_API_KEY` configurada en el entorno (SuperAdmin).
2. [ ] El plan del establecimiento tiene automatizaciones y un límite mensual razonable.
3. [ ] WhatsApp activo y probado (docs/WHATSAPP_META_SETUP.md).
4. [ ] Tarifas, paquetes, servicios, preguntas frecuentes, políticas y horario cargados.
5. [ ] Conversación de prueba real con tu propio número: precio, disponibilidad, solicitud de reserva, «quiero hablar con una persona», una
       pregunta fuera de lo cargado (debe derivar) y un intento de que invente un precio.
6. [ ] Revisar `BotUsage` (tokens por turno) para estimar el costo mensual.
