-- CreateEnum
CREATE TYPE "EscalationReason" AS ENUM ('ai_error', 'ai_uncertain', 'delivery_failed');

-- CreateEnum
CREATE TYPE "EscalationStatus" AS ENUM ('open', 'resolved');

-- CreateTable
CREATE TABLE "ai_escalations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "message_id" UUID,
    "question" TEXT NOT NULL,
    "reason" "EscalationReason" NOT NULL,
    "detail" TEXT,
    "status" "EscalationStatus" NOT NULL DEFAULT 'open',
    "resolved_by" UUID,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_escalations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_escalations_user_id_idx" ON "ai_escalations"("user_id");

-- CreateIndex
CREATE INDEX "ai_escalations_device_id_idx" ON "ai_escalations"("device_id");

-- CreateIndex
CREATE INDEX "ai_escalations_status_idx" ON "ai_escalations"("status");

-- AddForeignKey
ALTER TABLE "ai_escalations" ADD CONSTRAINT "ai_escalations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_escalations" ADD CONSTRAINT "ai_escalations_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_escalations" ADD CONSTRAINT "ai_escalations_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
