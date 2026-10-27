-- =====================================================================
-- Triada redesign (editado a mano para preservar datos existentes)
--  * PaymentMethod CARD  -> TRANSFER (reference = 'MIGRADO-TARJETA' si venía vacía)
--  * UserRole DEVICE     -> WAITER
--  * CashMovement: se eliminan los movimientos source=SALE (las ventas ahora se
--    calculan desde Payment; mantenerlos duplicaría el efectivo). reason = reason|description|'Movimiento migrado'
--  * CashRegister.userId -> openedById (y closedById para las cerradas); currentBalance se descarta
--    (el esperado se calcula). Si hay varias cajas OPEN por restaurante se cierran las más antiguas.
--  * Order.number: correlativo según createdAt de los pedidos existentes
--  * OrderItem.productName/taxable: snapshot desde Product
--  * Sale.cashRegisterId: la caja del mismo restaurante abierta más recientemente antes de la venta;
--    si no hay, la más antigua del restaurante; si el restaurante no tiene cajas, se crea una caja
--    CLOSED "legacy" por restaurante. cashAmount/transferAmount = suma de pagos por método.
--  * Payment.cashRegisterId = el de su venta.
--  * Device y Product.deviceId/imageUrl se eliminan.
-- =====================================================================
BEGIN;

-- ---------- Enums nuevos ----------
CREATE TYPE "PrinterConnection" AS ENUM ('BLUETOOTH', 'NETWORK', 'USB');
CREATE TYPE "PrinterPurpose" AS ENUM ('CASHIER', 'KITCHEN', 'BAR');

-- ---------- PaymentMethod: quitar CARD ----------
UPDATE "Payment" SET "reference" = COALESCE(NULLIF(TRIM("reference"), ''), 'MIGRADO-TARJETA') WHERE "method" = 'CARD';
UPDATE "Payment" SET "method" = 'TRANSFER' WHERE "method" = 'CARD';
CREATE TYPE "PaymentMethod_new" AS ENUM ('CASH', 'TRANSFER');
ALTER TABLE "Payment" ALTER COLUMN "method" TYPE "PaymentMethod_new" USING ("method"::text::"PaymentMethod_new");
ALTER TYPE "PaymentMethod" RENAME TO "PaymentMethod_old";
ALTER TYPE "PaymentMethod_new" RENAME TO "PaymentMethod";
DROP TYPE "PaymentMethod_old";

-- ---------- UserRole: quitar DEVICE ----------
UPDATE "User" SET "role" = 'WAITER' WHERE "role" = 'DEVICE';
CREATE TYPE "UserRole_new" AS ENUM ('ADMIN', 'CASHIER', 'WAITER');
ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "User" ALTER COLUMN "role" TYPE "UserRole_new" USING ("role"::text::"UserRole_new");
ALTER TYPE "UserRole" RENAME TO "UserRole_old";
ALTER TYPE "UserRole_new" RENAME TO "UserRole";
DROP TYPE "UserRole_old";
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'WAITER';

-- ---------- Drop FKs / índices viejos ----------
ALTER TABLE "Area" DROP CONSTRAINT "Area_restaurantId_fkey";
ALTER TABLE "CashMovement" DROP CONSTRAINT "CashMovement_cashRegisterId_fkey";
ALTER TABLE "CashMovement" DROP CONSTRAINT "CashMovement_restaurantId_fkey";
ALTER TABLE "CashMovement" DROP CONSTRAINT "CashMovement_saleId_fkey";
ALTER TABLE "CashRegister" DROP CONSTRAINT "CashRegister_restaurantId_fkey";
ALTER TABLE "CashRegister" DROP CONSTRAINT "CashRegister_userId_fkey";
ALTER TABLE "Device" DROP CONSTRAINT "Device_restaurantId_fkey";
ALTER TABLE "Order" DROP CONSTRAINT "Order_restaurantId_fkey";
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_restaurantId_fkey";
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_saleId_fkey";
ALTER TABLE "Product" DROP CONSTRAINT "Product_deviceId_fkey";
ALTER TABLE "Product" DROP CONSTRAINT "Product_restaurantId_fkey";
ALTER TABLE "Sale" DROP CONSTRAINT "Sale_orderId_fkey";
ALTER TABLE "Sale" DROP CONSTRAINT "Sale_restaurantId_fkey";
ALTER TABLE "Table" DROP CONSTRAINT "Table_areaId_fkey";
ALTER TABLE "Table" DROP CONSTRAINT "Table_restaurantId_fkey";
ALTER TABLE "User" DROP CONSTRAINT "User_restaurantId_fkey";

DROP INDEX "Area_restaurantId_idx";
DROP INDEX "CashMovement_cashRegisterId_idx";
DROP INDEX "CashMovement_createdAt_idx";
DROP INDEX "CashMovement_restaurantId_idx";
DROP INDEX "CashMovement_saleId_key";
DROP INDEX "CashMovement_source_idx";
DROP INDEX "CashMovement_type_idx";
DROP INDEX "CashRegister_createdAt_idx";
DROP INDEX "CashRegister_restaurantId_idx";
DROP INDEX "CashRegister_status_idx";
DROP INDEX "Order_createdAt_idx";
DROP INDEX "Order_restaurantId_idx";
DROP INDEX "Order_status_idx";
DROP INDEX "Order_tableId_idx";
DROP INDEX "Payment_createdAt_idx";
DROP INDEX "Payment_method_idx";
DROP INDEX "Payment_restaurantId_idx";
DROP INDEX "Payment_status_idx";
DROP INDEX "Product_available_idx";
DROP INDEX "Product_deviceId_idx";
DROP INDEX "Product_restaurantId_idx";
DROP INDEX "Sale_createdAt_idx";
DROP INDEX "Sale_restaurantId_idx";
DROP INDEX "Table_restaurantId_idx";
DROP INDEX "Table_status_idx";
DROP INDEX "User_email_idx";
DROP INDEX "User_restaurantId_idx";
DROP INDEX "User_role_idx";

-- ---------- Restaurant ----------
ALTER TABLE "Restaurant" ADD COLUMN "pricesIncludeTax" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "ruc" TEXT,
ADD COLUMN "taxRate" DECIMAL(5,2) NOT NULL DEFAULT 15;

-- ---------- Product ----------
ALTER TABLE "Product" DROP COLUMN "deviceId",
DROP COLUMN "imageUrl",
ADD COLUMN "taxable" BOOLEAN NOT NULL DEFAULT true;

-- ---------- Device ----------
DROP TABLE "Device";

-- ---------- Table ----------
ALTER TABLE "Table" ADD COLUMN "seats" INTEGER;

-- ---------- CashRegister ----------
ALTER TABLE "CashRegister"
ADD COLUMN "closedById" TEXT,
ADD COLUMN "closingNotes" TEXT,
ADD COLUMN "countedCash" DECIMAL(10,2),
ADD COLUMN "difference" DECIMAL(10,2),
ADD COLUMN "expectedCash" DECIMAL(10,2),
ADD COLUMN "notes" TEXT,
ADD COLUMN "openedById" TEXT;

UPDATE "CashRegister" SET "openedById" = "userId";
UPDATE "CashRegister" SET "closedById" = "userId", "closedAt" = COALESCE("closedAt", "updatedAt") WHERE "status" = 'CLOSED';

-- Si hay varias cajas abiertas por restaurante, se cierran las más antiguas
UPDATE "CashRegister" c
SET "status" = 'CLOSED',
    "closedAt" = CURRENT_TIMESTAMP,
    "closedById" = c."userId",
    "closingNotes" = 'Cerrada automáticamente por migración (había más de una caja abierta)'
WHERE c."status" = 'OPEN'
  AND c."id" <> (
    SELECT c2."id" FROM "CashRegister" c2
    WHERE c2."restaurantId" = c."restaurantId" AND c2."status" = 'OPEN'
    ORDER BY c2."openedAt" DESC, c2."id" DESC
    LIMIT 1
  );

ALTER TABLE "CashRegister" ALTER COLUMN "openedById" SET NOT NULL;
ALTER TABLE "CashRegister" DROP COLUMN "currentBalance", DROP COLUMN "userId";

-- ---------- CashMovement (solo manuales) ----------
DELETE FROM "CashMovement" WHERE "source" = 'SALE';
UPDATE "CashMovement"
SET "reason" = COALESCE(NULLIF(TRIM("reason"), ''), NULLIF(TRIM("description"), ''), 'Movimiento migrado');
ALTER TABLE "CashMovement" DROP COLUMN "description",
DROP COLUMN "saleId",
DROP COLUMN "source",
ALTER COLUMN "reason" SET NOT NULL;

-- ---------- Order.number (correlativo por fecha de creación) ----------
CREATE SEQUENCE "Order_number_seq";
ALTER TABLE "Order" ADD COLUMN "number" INTEGER;
UPDATE "Order" o SET "number" = s.rn
FROM (SELECT "id", ROW_NUMBER() OVER (ORDER BY "createdAt", "id") AS rn FROM "Order") s
WHERE o."id" = s."id";
SELECT setval('"Order_number_seq"', COALESCE((SELECT MAX("number") FROM "Order"), 0) + 1, false);
ALTER TABLE "Order" ALTER COLUMN "number" SET DEFAULT nextval('"Order_number_seq"');
ALTER TABLE "Order" ALTER COLUMN "number" SET NOT NULL;
ALTER SEQUENCE "Order_number_seq" OWNED BY "Order"."number";

-- ---------- OrderItem snapshot ----------
ALTER TABLE "OrderItem" ADD COLUMN "productName" TEXT,
ADD COLUMN "taxable" BOOLEAN NOT NULL DEFAULT true;
UPDATE "OrderItem" oi SET "productName" = p."name", "taxable" = p."taxable"
FROM "Product" p WHERE p."id" = oi."productId";
UPDATE "OrderItem" SET "productName" = 'Producto' WHERE "productName" IS NULL;
ALTER TABLE "OrderItem" ALTER COLUMN "productName" SET NOT NULL;

-- ---------- Sale ----------
ALTER TABLE "Sale" ADD COLUMN "cashAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN "cashRegisterId" TEXT,
ADD COLUMN "transferAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- 1) caja del restaurante abierta más recientemente antes de la venta
UPDATE "Sale" s SET "cashRegisterId" = (
  SELECT c."id" FROM "CashRegister" c
  WHERE c."restaurantId" = s."restaurantId" AND c."openedAt" <= s."createdAt"
  ORDER BY c."openedAt" DESC LIMIT 1
);
-- 2) si no, la caja más antigua del restaurante
UPDATE "Sale" s SET "cashRegisterId" = (
  SELECT c."id" FROM "CashRegister" c
  WHERE c."restaurantId" = s."restaurantId"
  ORDER BY c."openedAt" ASC LIMIT 1
) WHERE s."cashRegisterId" IS NULL;
-- 3) si el restaurante no tiene cajas, crear una caja CLOSED "legacy"
INSERT INTO "CashRegister" ("id", "status", "openedAt", "closedAt", "initialAmount", "notes", "closingNotes",
  "openedById", "closedById", "restaurantId", "createdAt", "updatedAt")
SELECT 'legacy_' || s."restaurantId", 'CLOSED', MIN(s."createdAt"), MAX(s."createdAt"), 0,
  'Caja creada por migración para ventas históricas', 'Caja creada por migración',
  MIN(s."userId"), MIN(s."userId"), s."restaurantId", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Sale" s WHERE s."cashRegisterId" IS NULL
GROUP BY s."restaurantId";
UPDATE "Sale" s SET "cashRegisterId" = 'legacy_' || s."restaurantId" WHERE s."cashRegisterId" IS NULL;
ALTER TABLE "Sale" ALTER COLUMN "cashRegisterId" SET NOT NULL;

UPDATE "Sale" s SET
  "cashAmount" = COALESCE((SELECT SUM(p."amount") FROM "Payment" p WHERE p."saleId" = s."id" AND p."method" = 'CASH'), 0),
  "transferAmount" = COALESCE((SELECT SUM(p."amount") FROM "Payment" p WHERE p."saleId" = s."id" AND p."method" = 'TRANSFER'), 0);

-- ---------- Payment ----------
ALTER TABLE "Payment" DROP COLUMN "notes",
DROP COLUMN "status",
DROP COLUMN "updatedAt",
ADD COLUMN "cashRegisterId" TEXT;
UPDATE "Payment" p SET "cashRegisterId" = s."cashRegisterId" FROM "Sale" s WHERE s."id" = p."saleId";
ALTER TABLE "Payment" ALTER COLUMN "cashRegisterId" SET NOT NULL;

-- ---------- Enums sin uso ----------
DROP TYPE "CashMovementSource";
DROP TYPE "PaymentStatus";

-- ---------- Tablas nuevas ----------
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Printer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "connectionType" "PrinterConnection" NOT NULL,
    "address" TEXT,
    "paperWidth" INTEGER NOT NULL DEFAULT 80,
    "purpose" "PrinterPurpose" NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "restaurantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Printer_pkey" PRIMARY KEY ("id")
);

-- ---------- Índices ----------
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");
CREATE INDEX "Printer_restaurantId_purpose_idx" ON "Printer"("restaurantId", "purpose");
CREATE INDEX "CashMovement_cashRegisterId_type_idx" ON "CashMovement"("cashRegisterId", "type");
CREATE INDEX "CashMovement_restaurantId_createdAt_idx" ON "CashMovement"("restaurantId", "createdAt");
CREATE INDEX "CashRegister_restaurantId_status_idx" ON "CashRegister"("restaurantId", "status");
CREATE INDEX "CashRegister_restaurantId_openedAt_idx" ON "CashRegister"("restaurantId", "openedAt");
CREATE UNIQUE INDEX "Order_number_key" ON "Order"("number");
CREATE INDEX "Order_restaurantId_status_idx" ON "Order"("restaurantId", "status");
CREATE INDEX "Order_restaurantId_createdAt_idx" ON "Order"("restaurantId", "createdAt");
CREATE INDEX "Order_tableId_status_idx" ON "Order"("tableId", "status");
CREATE INDEX "Payment_cashRegisterId_method_idx" ON "Payment"("cashRegisterId", "method");
CREATE INDEX "Payment_restaurantId_createdAt_idx" ON "Payment"("restaurantId", "createdAt");
CREATE INDEX "Product_restaurantId_name_idx" ON "Product"("restaurantId", "name");
CREATE INDEX "Product_restaurantId_available_idx" ON "Product"("restaurantId", "available");
CREATE INDEX "Sale_restaurantId_createdAt_idx" ON "Sale"("restaurantId", "createdAt");
CREATE INDEX "Sale_cashRegisterId_idx" ON "Sale"("cashRegisterId");
CREATE INDEX "Table_restaurantId_status_idx" ON "Table"("restaurantId", "status");
CREATE INDEX "User_restaurantId_role_idx" ON "User"("restaurantId", "role");

-- Una sola caja abierta por restaurante (índice único parcial, no representable en schema.prisma)
CREATE UNIQUE INDEX "CashRegister_one_open_per_restaurant" ON "CashRegister"("restaurantId") WHERE "status" = 'OPEN';

-- ---------- FKs (sin cascadas que borren historial) ----------
ALTER TABLE "User" ADD CONSTRAINT "User_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Product" ADD CONSTRAINT "Product_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Area" ADD CONSTRAINT "Area_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Table" ADD CONSTRAINT "Table_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Table" ADD CONSTRAINT "Table_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_cashRegisterId_fkey" FOREIGN KEY ("cashRegisterId") REFERENCES "CashRegister"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_cashRegisterId_fkey" FOREIGN KEY ("cashRegisterId") REFERENCES "CashRegister"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CashRegister" ADD CONSTRAINT "CashRegister_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CashRegister" ADD CONSTRAINT "CashRegister_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CashRegister" ADD CONSTRAINT "CashRegister_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_cashRegisterId_fkey" FOREIGN KEY ("cashRegisterId") REFERENCES "CashRegister"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Printer" ADD CONSTRAINT "Printer_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
