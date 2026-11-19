-- Fase 14 (pendiente): tope de gasto del cajero configurable por establecimiento (S/ 100.00 por defecto)
ALTER TABLE "Tenant" ADD COLUMN "cashierExpenseLimitCents" INTEGER NOT NULL DEFAULT 10000 CHECK ("cashierExpenseLimitCents" >= 0 AND "cashierExpenseLimitCents" <= 1000000);

-- Fase 15: facturación electrónica SUNAT
CREATE TABLE "SunatConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'MOCK',
    "sunatApiUrl" TEXT,
    "sunatTokenEnc" TEXT,
    "sunatTokenLast4" TEXT,
    "rucEmisor" TEXT NOT NULL,
    "razonSocial" TEXT NOT NULL,
    "serieBoleta" TEXT NOT NULL DEFAULT 'B001',
    "serieFactura" TEXT NOT NULL DEFAULT 'F001',
    "serieNcBoleta" TEXT NOT NULL DEFAULT 'BC01',
    "serieNcFactura" TEXT NOT NULL DEFAULT 'FC01',
    "igvBp" INTEGER NOT NULL DEFAULT 1800,
    "autoIssue" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "lastTestAt" DATETIME,
    "lastTestOk" BOOLEAN,
    "lastTestError" TEXT,
    "updatedById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SunatConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SunatConfig_provider_check" CHECK ("provider" IN ('MOCK','NUBEFACT')),
    CONSTRAINT "SunatConfig_igv_check" CHECK ("igvBp" >= 0 AND "igvBp" <= 2500),
    CONSTRAINT "SunatConfig_ruc_check" CHECK (length("rucEmisor") = 11),
    CONSTRAINT "SunatConfig_series_check" CHECK ("serieBoleta" LIKE 'B___' AND "serieFactura" LIKE 'F___' AND "serieNcBoleta" LIKE 'B___' AND "serieNcFactura" LIKE 'F___'
      AND "serieBoleta" <> "serieNcBoleta" AND "serieFactura" <> "serieNcFactura"),
    CONSTRAINT "SunatConfig_nubefact_check" CHECK ("provider" <> 'NUBEFACT' OR ("sunatApiUrl" IS NOT NULL AND "sunatTokenEnc" IS NOT NULL))
);

CREATE TABLE "SunatSeries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "serie" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "SunatSeries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SunatSeries_last_check" CHECK ("lastNumber" >= 0 AND "lastNumber" <= 99999999)
);

CREATE TABLE "SunatDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL,
    "serie" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "issueDate" TEXT NOT NULL,
    "saleId" TEXT,
    "creditedDocumentId" TEXT,
    "creditNoteReason" TEXT,
    "creditNoteReasonText" TEXT,
    "customerDocType" TEXT NOT NULL,
    "customerDocNumber" TEXT,
    "customerName" TEXT NOT NULL,
    "customerAddress" TEXT,
    "customerEmail" TEXT,
    "igvBp" INTEGER NOT NULL,
    "taxableCents" INTEGER NOT NULL,
    "igvCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "items" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME,
    "lockedUntil" DATETIME,
    "lastAttemptAt" DATETIME,
    "lastError" TEXT,
    "responseCode" TEXT,
    "responseDescription" TEXT,
    "hash" TEXT,
    "qr" TEXT,
    "pdfUrl" TEXT,
    "xmlUrl" TEXT,
    "cdrUrl" TEXT,
    "xml" TEXT,
    "pdf" BLOB,
    "acceptedAt" DATETIME,
    "creditedAt" DATETIME,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SunatDocument_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SunatDocument_kind_check" CHECK ("kind" IN ('BOLETA','FACTURA','CREDIT_NOTE')),
    CONSTRAINT "SunatDocument_status_check" CHECK ("status" IN ('PENDING','ACCEPTED','REJECTED','FAILED')),
    CONSTRAINT "SunatDocument_provider_check" CHECK ("provider" IN ('MOCK','NUBEFACT')),
    CONSTRAINT "SunatDocument_customer_check" CHECK ("customerDocType" IN ('DNI','RUC','NONE')),
    CONSTRAINT "SunatDocument_factura_ruc_check" CHECK ("kind" <> 'FACTURA' OR "customerDocType" = 'RUC'),
    CONSTRAINT "SunatDocument_ruc_len_check" CHECK ("customerDocType" <> 'RUC' OR length("customerDocNumber") = 11),
    CONSTRAINT "SunatDocument_dni_len_check" CHECK ("customerDocType" <> 'DNI' OR length("customerDocNumber") = 8),
    CONSTRAINT "SunatDocument_totals_check" CHECK ("totalCents" > 0 AND "taxableCents" > 0 AND "igvCents" >= 0 AND "taxableCents" + "igvCents" = "totalCents"),
    CONSTRAINT "SunatDocument_number_check" CHECK ("number" > 0 AND "attempts" >= 0),
    CONSTRAINT "SunatDocument_link_check" CHECK (
      ("kind" = 'CREDIT_NOTE' AND "creditedDocumentId" IS NOT NULL AND "saleId" IS NULL AND "creditNoteReason" IS NOT NULL)
      OR ("kind" <> 'CREDIT_NOTE' AND "saleId" IS NOT NULL AND "creditedDocumentId" IS NULL AND "creditNoteReason" IS NULL)),
    CONSTRAINT "SunatDocument_accepted_check" CHECK (("status" = 'ACCEPTED') = ("acceptedAt" IS NOT NULL))
);

CREATE UNIQUE INDEX "SunatConfig_tenantId_key" ON "SunatConfig"("tenantId");
CREATE UNIQUE INDEX "SunatSeries_tenantId_serie_key" ON "SunatSeries"("tenantId", "serie");
CREATE UNIQUE INDEX "SunatDocument_tenantId_id_key" ON "SunatDocument"("tenantId", "id");
CREATE UNIQUE INDEX "SunatDocument_tenantId_serie_number_key" ON "SunatDocument"("tenantId", "serie", "number");
CREATE UNIQUE INDEX "SunatDocument_tenantId_saleId_key" ON "SunatDocument"("tenantId", "saleId");
CREATE UNIQUE INDEX "SunatDocument_tenantId_creditedDocumentId_key" ON "SunatDocument"("tenantId", "creditedDocumentId");
CREATE INDEX "SunatDocument_tenantId_status_nextAttemptAt_idx" ON "SunatDocument"("tenantId", "status", "nextAttemptAt");
CREATE INDEX "SunatDocument_tenantId_issueDate_idx" ON "SunatDocument"("tenantId", "issueDate");
