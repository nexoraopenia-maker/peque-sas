-- Fase 17: precios de plan, suscripciones y cobros SaaS
ALTER TABLE "Plan" ADD COLUMN "priceCents" INTEGER NOT NULL DEFAULT 0 CHECK ("priceCents" >= 0 AND "priceCents" <= 100000000);
ALTER TABLE "Plan" ADD COLUMN "billingPeriodDays" INTEGER NOT NULL DEFAULT 30 CHECK ("billingPeriodDays" >= 1 AND "billingPeriodDays" <= 366);
ALTER TABLE "Tenant" ADD COLUMN "suspensionSource" TEXT CHECK ("suspensionSource" IS NULL OR "suspensionSource" IN ('ADMIN','BILLING'));

CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "currentPeriodStart" DATETIME NOT NULL,
    "currentPeriodEnd" DATETIME NOT NULL,
    "graceUntil" DATETIME,
    "canceledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Subscription_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Subscription_status_check" CHECK ("status" IN ('ACTIVE','PAST_DUE','CANCELED')),
    CONSTRAINT "Subscription_period_check" CHECK ("currentPeriodEnd" > "currentPeriodStart"),
    CONSTRAINT "Subscription_canceled_check" CHECK (("status" = 'CANCELED') = ("canceledAt" IS NOT NULL))
);

CREATE TABLE "SaasInvoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "planName" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "periodStart" DATETIME NOT NULL,
    "periodEnd" DATETIME NOT NULL,
    "dueDate" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "method" TEXT,
    "provider" TEXT,
    "providerRef" TEXT,
    "reportedMethod" TEXT,
    "reportedRef" TEXT,
    "reportedAt" DATETIME,
    "rejectedReason" TEXT,
    "paidAt" DATETIME,
    "paidById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SaasInvoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SaasInvoice_status_check" CHECK ("status" IN ('PENDING','PAID','VOID')),
    CONSTRAINT "SaasInvoice_amount_check" CHECK ("amountCents" > 0),
    CONSTRAINT "SaasInvoice_period_check" CHECK ("periodEnd" > "periodStart"),
    CONSTRAINT "SaasInvoice_paid_check" CHECK (("status" = 'PAID') = ("paidAt" IS NOT NULL)),
    CONSTRAINT "SaasInvoice_method_check" CHECK ("method" IS NULL OR "method" IN ('CARD','YAPE','PLIN','TRANSFER','OTHER')),
    CONSTRAINT "SaasInvoice_reported_check" CHECK ("reportedMethod" IS NULL OR "reportedMethod" IN ('YAPE','PLIN','TRANSFER'))
);

CREATE TABLE "PaymentEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "tenantId" TEXT,
    "invoiceId" TEXT,
    "amountCents" INTEGER,
    "status" TEXT NOT NULL,
    "detail" TEXT,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" DATETIME,
    CONSTRAINT "PaymentEvent_status_check" CHECK ("status" IN ('RECEIVED','APPLIED','IGNORED','ERROR'))
);

CREATE UNIQUE INDEX "Subscription_tenantId_key" ON "Subscription"("tenantId");
CREATE UNIQUE INDEX "SaasInvoice_tenantId_id_key" ON "SaasInvoice"("tenantId", "id");
CREATE UNIQUE INDEX "SaasInvoice_tenantId_periodStart_key" ON "SaasInvoice"("tenantId", "periodStart");
CREATE INDEX "SaasInvoice_tenantId_status_idx" ON "SaasInvoice"("tenantId", "status");
CREATE UNIQUE INDEX "PaymentEvent_provider_eventId_key" ON "PaymentEvent"("provider", "eventId");
