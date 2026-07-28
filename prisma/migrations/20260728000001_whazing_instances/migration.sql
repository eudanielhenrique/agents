-- CreateTable
CREATE TABLE "whazing_instances" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "api_key" TEXT NOT NULL,
    "route_token" TEXT NOT NULL,
    "route_token_hash" TEXT NOT NULL,
    "disconnected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whazing_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whazing_inboxes" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "instance_id" BIGINT NOT NULL,
    "whazing_queue_id" TEXT,
    "name" TEXT,
    "agent_id" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whazing_inboxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whazing_webhook_deliveries" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "instance_id" BIGINT NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "status" "InboundDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "whazing_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whazing_instances_route_token_hash_key" ON "whazing_instances"("route_token_hash");

-- CreateIndex
CREATE INDEX "whazing_instances_tenant_id_idx" ON "whazing_instances"("tenant_id");

-- CreateIndex — one baseUrl per tenant
CREATE UNIQUE INDEX "whazing_instances_tenant_id_base_url_key" ON "whazing_instances"("tenant_id", "base_url");

-- CreateIndex
CREATE INDEX "whazing_inboxes_tenant_id_idx" ON "whazing_inboxes"("tenant_id");

-- CreateIndex
CREATE INDEX "whazing_inboxes_instance_id_idx" ON "whazing_inboxes"("instance_id");

-- Partial unique index: enforce single catch-all per (tenant, instance)
CREATE UNIQUE INDEX "whazing_inboxes_catchall_unique"
    ON "whazing_inboxes" ("tenant_id", "instance_id")
    WHERE "whazing_queue_id" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "whazing_webhook_deliveries_instance_id_delivery_id_key" ON "whazing_webhook_deliveries"("instance_id", "delivery_id");

-- CreateIndex
CREATE INDEX "whazing_webhook_deliveries_tenant_id_idx" ON "whazing_webhook_deliveries"("tenant_id");

-- AddForeignKey
ALTER TABLE "whazing_instances" ADD CONSTRAINT "whazing_instances_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whazing_inboxes" ADD CONSTRAINT "whazing_inboxes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whazing_inboxes" ADD CONSTRAINT "whazing_inboxes_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "whazing_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whazing_inboxes" ADD CONSTRAINT "whazing_inboxes_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whazing_webhook_deliveries" ADD CONSTRAINT "whazing_webhook_deliveries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whazing_webhook_deliveries" ADD CONSTRAINT "whazing_webhook_deliveries_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "whazing_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS
ALTER TABLE "whazing_instances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whazing_instances" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "whazing_instances"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::BIGINT
      OR current_setting('app.is_super_admin', TRUE) = 'true');

ALTER TABLE "whazing_inboxes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whazing_inboxes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "whazing_inboxes"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::BIGINT
      OR current_setting('app.is_super_admin', TRUE) = 'true');

ALTER TABLE "whazing_webhook_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whazing_webhook_deliveries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "whazing_webhook_deliveries"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::BIGINT
      OR current_setting('app.is_super_admin', TRUE) = 'true');
