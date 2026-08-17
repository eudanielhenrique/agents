-- AlterEnum
ALTER TYPE "SchedulerJobKind" ADD VALUE 'WHAZING_RECONCILE';

-- AlterTable
ALTER TABLE "whazing_conversations" ADD COLUMN "contact_phone" TEXT;
