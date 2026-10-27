/*
  Warnings:

  - You are about to drop the column `number` on the `Table` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[restaurantId,name]` on the table `Table` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `name` to the `Table` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "Table_restaurantId_number_key";

-- AlterTable
ALTER TABLE "Table" DROP COLUMN "number",
ADD COLUMN     "name" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Table_restaurantId_name_key" ON "Table"("restaurantId", "name");
