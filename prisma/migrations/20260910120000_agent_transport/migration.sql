-- AlterTable
ALTER TABLE "agents" ADD COLUMN "transport" TEXT;

-- Backfill: infer each agent's channel from its current bindings. WHAZING wins when an agent is
-- bound on both sides (the dominant live case today) instead of blocking on it; agents bound to
-- neither side stay NULL until the operator picks in the editor (assertAgentTransport sets it on
-- first bind). Whazing's native tool names collide with Chatwoot's (docs/whazing.md), so an agent
-- answering both channels at once was already unsupported in practice — this just makes it explicit.
UPDATE "agents" a
SET "transport" = 'WHAZING'
WHERE EXISTS (
  SELECT 1 FROM "whazing_inboxes" wi
  JOIN "whazing_instances" wins ON wins."id" = wi."instance_id"
  WHERE wi."agent_id" = a."id" AND wins."disconnected_at" IS NULL
);

UPDATE "agents" a
SET "transport" = 'CHATWOOT'
WHERE a."transport" IS NULL
  AND EXISTS (
    SELECT 1 FROM "inboxes" ib
    JOIN "chatwoot_instances" ci ON ci."id" = ib."chatwoot_instance_id"
    WHERE ib."agent_id" = a."id" AND ci."disconnected_at" IS NULL
  );

-- Flag agents bound on BOTH channels (backfilled to WHAZING above) so they get resolved by hand —
-- never auto-unbind data in a migration.
DO $$
DECLARE
  conflict RECORD;
BEGIN
  FOR conflict IN
    SELECT a."id", a."name"
    FROM "agents" a
    WHERE EXISTS (
      SELECT 1 FROM "whazing_inboxes" wi
      JOIN "whazing_instances" wins ON wins."id" = wi."instance_id"
      WHERE wi."agent_id" = a."id" AND wins."disconnected_at" IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM "inboxes" ib
      JOIN "chatwoot_instances" ci ON ci."id" = ib."chatwoot_instance_id"
      WHERE ib."agent_id" = a."id" AND ci."disconnected_at" IS NULL
    )
  LOOP
    RAISE NOTICE 'agent % (%) is bound on BOTH Chatwoot and Whazing — backfilled to WHAZING, resolve manually', conflict.id, conflict.name;
  END LOOP;
END $$;
