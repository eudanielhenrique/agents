-- CreateTable: PromptTestCase — single-turn prompt-regression scenarios per agent.
CREATE TABLE "prompt_test_cases" (
    "id"           BIGSERIAL    NOT NULL,
    "tenant_id"    BIGINT       NOT NULL,
    "agent_id"     BIGINT       NOT NULL,
    "name"         TEXT         NOT NULL,
    "user_message" TEXT         NOT NULL,
    "assertions"   JSONB        NOT NULL DEFAULT '{}',
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_test_cases_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "prompt_test_cases_tenant_id_idx" ON "prompt_test_cases"("tenant_id");
CREATE INDEX "prompt_test_cases_agent_id_idx" ON "prompt_test_cases"("agent_id");

-- FKs
ALTER TABLE "prompt_test_cases"
  ADD CONSTRAINT "prompt_test_cases_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "prompt_test_cases"
  ADD CONSTRAINT "prompt_test_cases_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: same tenant-isolation pattern as all other tenant-scoped tables. Uses 'on' (not 'true')
-- for is_super_admin, matching asSuperAdminOn's set_config call — see the
-- 20260806010000_fix_whazing_conversations_rls migration for why this matters.
ALTER TABLE "prompt_test_cases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "prompt_test_cases" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "prompt_test_cases"
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::BIGINT
    OR current_setting('app.is_super_admin', true) = 'on'
  );

-- No GRANT statements here: scripts/db-bootstrap.ts's ALTER DEFAULT PRIVILEGES already covers
-- every table created after it runs — see .claude/rules/prisma.md.
