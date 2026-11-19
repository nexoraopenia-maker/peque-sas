-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "cashRegisterSessionId" TEXT,
    "expenseDate" TEXT NOT NULL,
    "supplier" TEXT,
    "reference" TEXT,
    "idempotencyKey" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" DATETIME,
    "voidedById" TEXT,
    "voidReason" TEXT,
    CONSTRAINT "Expense_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Expense_amount_check" CHECK ("amountCents" > 0),
    CONSTRAINT "Expense_category_check" CHECK ("category" IN ('OPERATING_SUPPLIES','PERSONNEL','RENT_UTILITIES','MARKETING_MISC')),
    CONSTRAINT "Expense_source_check" CHECK ("source" IN ('CASH_DRAWER','CASH_OTHER','YAPE_PLIN','CARD','TRANSFER')),
    CONSTRAINT "Expense_drawer_session_check" CHECK (("source" = 'CASH_DRAWER') = ("cashRegisterSessionId" IS NOT NULL)),
    CONSTRAINT "Expense_void_check" CHECK (("voidedAt" IS NULL) = ("voidReason" IS NULL))
);

-- AlterTable (en lugar de RedefineTables: no se recrea la tabla de caja)
ALTER TABLE "CashRegisterSession" ADD COLUMN "cashExpensesCents" INTEGER NOT NULL DEFAULT 0 CHECK ("cashExpensesCents" >= 0);

-- CreateIndex
CREATE UNIQUE INDEX "Expense_tenantId_id_key" ON "Expense"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Expense_tenantId_idempotencyKey_key" ON "Expense"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "Expense_tenantId_expenseDate_idx" ON "Expense"("tenantId", "expenseDate");

-- CreateIndex
CREATE INDEX "Expense_tenantId_cashRegisterSessionId_idx" ON "Expense"("tenantId", "cashRegisterSessionId");
