-- CreateTable
CREATE TABLE "configurator_link_codes" (
    "id" BIGSERIAL NOT NULL,
    "code_hash" TEXT NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "configurator_link_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "configurator_bindings" (
    "id" BIGSERIAL NOT NULL,
    "channel" TEXT NOT NULL,
    "instance_id" BIGINT NOT NULL,
    "external_contact_id" TEXT NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "bound_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "configurator_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "configurator_link_codes_code_hash_key" ON "configurator_link_codes"("code_hash");

-- CreateIndex
CREATE UNIQUE INDEX "configurator_bindings_channel_instance_id_external_contac_key" ON "configurator_bindings"("channel", "instance_id", "external_contact_id");

-- AddForeignKey
ALTER TABLE "configurator_link_codes" ADD CONSTRAINT "configurator_link_codes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "configurator_bindings" ADD CONSTRAINT "configurator_bindings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
