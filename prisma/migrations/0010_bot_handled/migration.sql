-- El bot marca explícitamente cada mensaje entrante que ya atendió (un cursor por fecha no sirve: la fecha del mensaje es de WhatsApp,
-- con precisión de segundos, y puede ser anterior a nuestra respuesta aunque el mensaje llegue después).
ALTER TABLE "WhatsAppMessage" ADD COLUMN "botHandledAt" DATETIME;
ALTER TABLE "WhatsAppConversation" DROP COLUMN "botCursorAt";
CREATE INDEX "WhatsAppMessage_unhandled_idx" ON "WhatsAppMessage"("tenantId", "conversationId", "direction", "botHandledAt");
