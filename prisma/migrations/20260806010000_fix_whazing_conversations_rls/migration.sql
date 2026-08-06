-- Fix whazing_conversations RLS policy: replace 'true' comparison with 'on' to match
-- asSuperAdminOn() (see set_config('app.is_super_admin', 'on', true) in multi-tenant.ts).
-- The 20260728000002_fix_whazing_rls migration fixed this exact bug for whazing_instances,
-- whazing_inboxes and whazing_webhook_deliveries; whazing_conversations was added one migration
-- later (20260729000001_whazing_conversations) and reintroduced the same 'true' mistake, so any
-- asSuperAdminOn/cross-tenant read of this table has silently returned zero rows ever since.

DROP POLICY "tenant_isolation" ON "whazing_conversations";
CREATE POLICY "tenant_isolation" ON "whazing_conversations"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::BIGINT
      OR current_setting('app.is_super_admin', TRUE) = 'on');
