-- Mesas con solo dos estados: AVAILABLE (Libre) y OCCUPIED (Ocupada). Se elimina RESERVED.
-- Primero se corrigen los datos inconsistentes; luego se reemplaza el enum. No se pierden filas.
BEGIN;

-- 1) Reservadas -> Libres
UPDATE "Table" SET "status" = 'AVAILABLE' WHERE "status" = 'RESERVED';

-- 2) Ocupadas sin pedido OPEN -> Libres
UPDATE "Table" t SET "status" = 'AVAILABLE'
WHERE t."status" = 'OCCUPIED'
  AND NOT EXISTS (SELECT 1 FROM "Order" o WHERE o."tableId" = t."id" AND o."status" = 'OPEN');

-- 3) Toda mesa con pedido OPEN -> Ocupada
UPDATE "Table" t SET "status" = 'OCCUPIED'
WHERE t."status" <> 'OCCUPIED'
  AND EXISTS (SELECT 1 FROM "Order" o WHERE o."tableId" = t."id" AND o."status" = 'OPEN');

-- 4) Enum nuevo sin RESERVED
CREATE TYPE "TableStatus_new" AS ENUM ('AVAILABLE', 'OCCUPIED');

ALTER TABLE "Table" ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "Table" ALTER COLUMN "status" TYPE "TableStatus_new" USING (
  CASE "status"::text
    WHEN 'RESERVED' THEN 'AVAILABLE'
    ELSE "status"::text
  END
)::"TableStatus_new";

ALTER TYPE "TableStatus" RENAME TO "TableStatus_old";
ALTER TYPE "TableStatus_new" RENAME TO "TableStatus";
DROP TYPE "TableStatus_old";

ALTER TABLE "Table" ALTER COLUMN "status" SET DEFAULT 'AVAILABLE';

COMMIT;
