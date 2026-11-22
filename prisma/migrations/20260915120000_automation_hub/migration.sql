-- CreateTable: AutomationRule — persistence for the (already-built) automation engine in
-- src/modules/automations/. See PrismaAutomationRepository.
CREATE TABLE "automation_rules" (
    "id"             BIGSERIAL    NOT NULL,
    "tenant_id"      BIGINT       NOT NULL,
    "name"           TEXT         NOT NULL,
    "description"    TEXT,
    "enabled"        BOOLEAN      NOT NULL DEFAULT true,
    "trigger_type"   TEXT         NOT NULL,
    "trigger_filter" JSONB,
    "conditions"     JSONB        NOT NULL DEFAULT '[]',
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable: AutomationAction — ordered action pipeline belonging to a rule.
CREATE TABLE "automation_actions" (
    "id"             BIGSERIAL    NOT NULL,
    "tenant_id"      BIGINT       NOT NULL,
    "rule_id"        BIGINT       NOT NULL,
    "order"          INTEGER      NOT NULL DEFAULT 0,
    "provider"       TEXT         NOT NULL,
    "action_type"    TEXT         NOT NULL,
    "credential_ref" TEXT,
    "field_mapping"  JSONB        NOT NULL DEFAULT '{}',
    "settings"       JSONB        NOT NULL DEFAULT '{}',

    CONSTRAINT "automation_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable: AutomationExecutionLog — structured (no-PII) execution history.
CREATE TABLE "automation_execution_logs" (
    "id"                BIGSERIAL    NOT NULL,
    "tenant_id"         BIGINT       NOT NULL,
    "rule_id"           BIGINT       NOT NULL,
    "trigger_type"      TEXT         NOT NULL,
    "status"            TEXT         NOT NULL,
    "conditions_passed" BOOLEAN      NOT NULL,
    "steps"             JSONB        NOT NULL DEFAULT '[]',
    "error_message"     TEXT,
    "total_duration_ms" INTEGER      NOT NULL DEFAULT 0,
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_execution_logs_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "automation_rules_tenant_id_idx" ON "automation_rules"("tenant_id");
CREATE INDEX "automation_rules_tenant_id_trigger_type_enabled_idx" ON "automation_rules"("tenant_id", "trigger_type", "enabled");

CREATE INDEX "automation_actions_tenant_id_idx" ON "automation_actions"("tenant_id");
CREATE INDEX "automation_actions_rule_id_idx" ON "automation_actions"("rule_id");

CREATE INDEX "automation_execution_logs_tenant_id_rule_id_idx" ON "automation_execution_logs"("tenant_id", "rule_id");
CREATE INDEX "automation_execution_logs_tenant_id_created_at_idx" ON "automation_execution_logs"("tenant_id", "created_at");

-- FKs
ALTER TABLE "automation_rules"
  ADD CONSTRAINT "automation_rules_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "automation_actions"
  ADD CONSTRAINT "automation_actions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automation_actions"
  ADD CONSTRAINT "automation_actions_rule_id_fkey"
  FOREIGN KEY ("rule_id") REFERENCES "automation_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "automation_execution_logs"
  ADD CONSTRAINT "automation_execution_logs_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automation_execution_logs"
  ADD CONSTRAINT "automation_execution_logs_rule_id_fkey"
  FOREIGN KEY ("rule_id") REFERENCES "automation_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: same tenant-isolation pattern as every other tenant-scoped table (see
-- 20260806020000_prompt_test_cases). Uses 'on' (not 'true') for is_super_admin, matching
-- asSuperAdminOn's set_config call.
ALTER TABLE "automation_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "automation_rules" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "automation_rules"
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::BIGINT
    OR current_setting('app.is_super_admin', true) = 'on'
  );

ALTER TABLE "automation_actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "automation_actions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "automation_actions"
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::BIGINT
    OR current_setting('app.is_super_admin', true) = 'on'
  );

ALTER TABLE "automation_execution_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "automation_execution_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "automation_execution_logs"
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::BIGINT
    OR current_setting('app.is_super_admin', true) = 'on'
  );

-- No GRANT statements here: scripts/db-bootstrap.ts's ALTER DEFAULT PRIVILEGES already covers
-- every table created after it runs — see .claude/rules/prisma.md.
