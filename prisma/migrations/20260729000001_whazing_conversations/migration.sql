-- CreateTable: WhazingConversation — mirror of Whazing ticket metadata, no PII.
CREATE TABLE "whazing_conversations" (
    "id"               BIGSERIAL    NOT NULL,
    "tenant_id"        BIGINT       NOT NULL,
    "instance_id"      BIGINT       NOT NULL,
    "inbox_id"         BIGINT,
    "ticket_id"        INTEGER      NOT NULL,
    "thread_id"        TEXT         NOT NULL,
    "status"           TEXT         NOT NULL DEFAULT 'open',
    "assigned_user_id" INTEGER,
    "contact_id"       INTEGER,
    "contact_name"     TEXT,
    "agent_id"         BIGINT,
    "last_event_at"    TIMESTAMP(3),
    "last_inbound_at"  TIMESTAMP(3),
    "last_error"       TEXT,
    "last_error_at"    TIMESTAMP(3),
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whazing_conversations_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "whazing_conversations_tenant_id_instance_id_ticket_id_key"
  ON "whazing_conversations"("tenant_id", "instance_id", "ticket_id");
CREATE INDEX "whazing_conversations_tenant_id_idx"
  ON "whazing_conversations"("tenant_id");
CREATE INDEX "whazing_conversations_instance_id_idx"
  ON "whazing_conversations"("instance_id");
CREATE INDEX "whazing_conversations_tenant_last_event_idx"
  ON "whazing_conversations"("tenant_id", "last_event_at" DESC NULLS LAST);

-- FKs
ALTER TABLE "whazing_conversations"
  ADD CONSTRAINT "whazing_conversations_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "whazing_conversations"
  ADD CONSTRAINT "whazing_conversations_instance_id_fkey"
  FOREIGN KEY ("instance_id") REFERENCES "whazing_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "whazing_conversations"
  ADD CONSTRAINT "whazing_conversations_inbox_id_fkey"
  FOREIGN KEY ("inbox_id") REFERENCES "whazing_inboxes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS: same tenant-isolation pattern as all other tenant-scoped tables.
ALTER TABLE "whazing_conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whazing_conversations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "whazing_conversations"
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::BIGINT
    OR current_setting('app.is_super_admin', true) = 'true'
  );

-- Runtime role GRANTs (same as other public tables; bootstrap.ts is authoritative but this is
-- belt-and-suspenders for tables added after the initial bootstrap).
GRANT SELECT, INSERT, UPDATE, DELETE ON "whazing_conversations" TO secv4_app;
GRANT USAGE, SELECT ON SEQUENCE "whazing_conversations_id_seq" TO secv4_app;
