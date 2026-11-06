-- Refunds are scaled to the commission base and capped by what the sale sent.
-- AlterTable
ALTER TABLE "EventLog" ADD COLUMN     "amount" INTEGER,
ADD COLUMN     "goodsPaid" INTEGER;
