-- Fix Whazing RLS policies: replace 'true' comparison with 'on' to match asSuperAdminOn().
-- The baseline migration uses = 'on'; the whazing_instances migration used = 'true' by mistake.

DROP POLICY "tenant_isolation" ON "whazing_instances";
CREATE POLICY "tenant_isolation" ON "whazing_instances"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::BIGINT
      OR current_setting('app.is_super_admin', TRUE) = 'on');

DROP POLICY "tenant_isolation" ON "whazing_inboxes";
CREATE POLICY "tenant_isolation" ON "whazing_inboxes"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::BIGINT
      OR current_setting('app.is_super_admin', TRUE) = 'on');

DROP POLICY "tenant_isolation" ON "whazing_webhook_deliveries";
CREATE POLICY "tenant_isolation" ON "whazing_webhook_deliveries"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::BIGINT
      OR current_setting('app.is_super_admin', TRUE) = 'on');
