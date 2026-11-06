-- Orders that are not tied to an affiliate are never sent, so the switch is gone.
-- AlterTable
ALTER TABLE "ShopSettings" DROP COLUMN "requireTid";
