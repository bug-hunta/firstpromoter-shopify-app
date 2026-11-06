-- The CID of the tracking script is the Account ID, so it is no longer stored.
-- AlterTable
ALTER TABLE "ShopSettings" DROP COLUMN "cid",
ADD COLUMN     "couponPriority" TEXT NOT NULL DEFAULT 'link',
ADD COLUMN     "trackCoupons" BOOLEAN NOT NULL DEFAULT true;
