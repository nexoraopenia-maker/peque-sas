-- CreateTable
CREATE TABLE "CashRegisterSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "openingBalanceCents" INTEGER NOT NULL,
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedById" TEXT NOT NULL,
    "closedAt" DATETIME,
    "closedById" TEXT,
    "cashSalesCents" INTEGER,
    "yapePlinSalesCents" INTEGER,
    "cardSalesCents" INTEGER,
    "transferSalesCents" INTEGER,
    "cashRefundsCents" INTEGER NOT NULL DEFAULT 0,
    "expectedCashCents" INTEGER,
    "declaredCashCents" INTEGER,
    "differenceCents" INTEGER,
    CONSTRAINT "CashRegisterSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Sale" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "cashRegisterSessionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "cashCents" INTEGER NOT NULL DEFAULT 0,
    "yapePlinCents" INTEGER NOT NULL DEFAULT 0,
    "cardCents" INTEGER NOT NULL DEFAULT 0,
    "transferCents" INTEGER NOT NULL DEFAULT 0,
    "childId" TEXT,
    "playgroundSessionId" TEXT,
    "idempotencyKey" TEXT,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Sale_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Sale_tenantId_cashRegisterSessionId_fkey" FOREIGN KEY ("tenantId", "cashRegisterSessionId") REFERENCES "CashRegisterSession" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Sale_split_check" CHECK ("totalCents" >= 0 AND "cashCents" >= 0 AND "yapePlinCents" >= 0 AND "cardCents" >= 0 AND "transferCents" >= 0 AND "cashCents" + "yapePlinCents" + "cardCents" + "transferCents" = "totalCents")
);

-- CreateTable
CREATE TABLE "SaleItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPriceCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "productId" TEXT,
    CONSTRAINT "SaleItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SaleItem_tenantId_saleId_fkey" FOREIGN KEY ("tenantId", "saleId") REFERENCES "Sale" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PrepaidPackage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PrepaidPackage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PrepaidLedger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "packageId" TEXT,
    "saleId" TEXT,
    "playgroundSessionId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PrepaidLedger_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PrepaidLedger_tenantId_childId_fkey" FOREIGN KEY ("tenantId", "childId") REFERENCES "Child" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DaycareInvoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "dueDate" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "paidAt" DATETIME,
    "saleId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DaycareInvoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DaycareInvoice_tenantId_enrollmentId_fkey" FOREIGN KEY ("tenantId", "enrollmentId") REFERENCES "Enrollment" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlaygroundConsumption" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlaygroundConsumption_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PlaygroundConsumption_tenantId_sessionId_fkey" FOREIGN KEY ("tenantId", "sessionId") REFERENCES "PlaygroundSession" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PlaygroundConsumption_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "Product" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Columna con ALTER (evita recrear la tabla Child). El CHECK impide saldos de cuponera negativos a nivel de BD.
ALTER TABLE "Child" ADD COLUMN "prepaidMinutes" INTEGER NOT NULL DEFAULT 0 CHECK ("prepaidMinutes" >= 0);

-- CreateIndex
CREATE INDEX "CashRegisterSession_tenantId_status_idx" ON "CashRegisterSession"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CashRegisterSession_tenantId_id_key" ON "CashRegisterSession"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Sale_tenantId_cashRegisterSessionId_idx" ON "Sale"("tenantId", "cashRegisterSessionId");

-- CreateIndex
CREATE INDEX "Sale_tenantId_createdAt_idx" ON "Sale"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_tenantId_id_key" ON "Sale"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_tenantId_playgroundSessionId_key" ON "Sale"("tenantId", "playgroundSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_tenantId_idempotencyKey_key" ON "Sale"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "SaleItem_tenantId_saleId_idx" ON "SaleItem"("tenantId", "saleId");

-- CreateIndex
CREATE INDEX "PrepaidPackage_tenantId_idx" ON "PrepaidPackage"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PrepaidPackage_tenantId_id_key" ON "PrepaidPackage"("tenantId", "id");

-- CreateIndex
CREATE INDEX "PrepaidLedger_tenantId_childId_createdAt_idx" ON "PrepaidLedger"("tenantId", "childId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PrepaidLedger_tenantId_playgroundSessionId_type_key" ON "PrepaidLedger"("tenantId", "playgroundSessionId", "type");

-- CreateIndex
CREATE INDEX "DaycareInvoice_tenantId_period_status_idx" ON "DaycareInvoice"("tenantId", "period", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DaycareInvoice_tenantId_enrollmentId_period_key" ON "DaycareInvoice"("tenantId", "enrollmentId", "period");

-- CreateIndex
CREATE INDEX "PlaygroundConsumption_tenantId_sessionId_idx" ON "PlaygroundConsumption"("tenantId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "PlaygroundSession_tenantId_id_key" ON "PlaygroundSession"("tenantId", "id");



-- Un solo turno de caja abierto por establecimiento
CREATE UNIQUE INDEX "CashRegisterSession_open_key" ON "CashRegisterSession"("tenantId") WHERE "status" = 'OPEN';

-- Cantidad de consumo positiva
CREATE TRIGGER "PlaygroundConsumption_qty_check" BEFORE INSERT ON "PlaygroundConsumption" WHEN NEW."quantity" <= 0 OR NEW."unitPriceCents" < 0
BEGIN SELECT RAISE(ABORT, 'consumo inválido'); END;

-- El historial de la cuponera es inmutable: no se permite UPDATE
CREATE TRIGGER "PrepaidLedger_no_update" BEFORE UPDATE ON "PrepaidLedger"
BEGIN SELECT RAISE(ABORT, 'PrepaidLedger es inmutable'); END;

-- Saldo posterior nunca negativo
CREATE TRIGGER "PrepaidLedger_balance_check" BEFORE INSERT ON "PrepaidLedger" WHEN NEW."balanceAfter" < 0
BEGIN SELECT RAISE(ABORT, 'saldo negativo'); END;
