-- Simplifica OrderStatus a OPEN -> PAID (CANCELLED se conserva solo para filas históricas).
-- Conversión de datos: PENDING/PREPARING/DELIVERED -> OPEN. No se pierden filas.
BEGIN;

CREATE TYPE "OrderStatus_new" AS ENUM ('OPEN', 'PAID', 'CANCELLED');

ALTER TABLE "Order" ALTER COLUMN "status" DROP DEFAULT;

-- Los índices ("restaurantId","status") y ("tableId","status") se reconstruyen automáticamente.
ALTER TABLE "Order" ALTER COLUMN "status" TYPE "OrderStatus_new" USING (
  CASE "status"::text
    WHEN 'PENDING'   THEN 'OPEN'
    WHEN 'PREPARING' THEN 'OPEN'
    WHEN 'DELIVERED' THEN 'OPEN'
    ELSE "status"::text
  END
)::"OrderStatus_new";

ALTER TYPE "OrderStatus" RENAME TO "OrderStatus_old";
ALTER TYPE "OrderStatus_new" RENAME TO "OrderStatus";
DROP TYPE "OrderStatus_old";

ALTER TABLE "Order" ALTER COLUMN "status" SET DEFAULT 'OPEN';

COMMIT;
