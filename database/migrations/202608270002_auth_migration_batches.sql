BEGIN;

-- Existing auth databases may already have the enum from the base migration.
-- Keep this migration safe to rerun while converging the readiness boundary.
CREATE TABLE IF NOT EXISTS public.auth_migration_batches (
  batch_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  snapshot_hash BYTEA NOT NULL CHECK (octet_length(snapshot_hash) = 32),
  status public.auth_migration_status NOT NULL DEFAULT 'pending',
  source_count INTEGER NOT NULL CHECK (source_count >= 0),
  imported_count INTEGER NOT NULL CHECK (imported_count >= 0),
  conflict_count INTEGER NOT NULL CHECK (conflict_count >= 0),
  freeze_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (source, environment_id, site_id),
  CHECK (
    status <> 'reconciled' OR
    (completed_at IS NOT NULL AND source_count = imported_count AND conflict_count = 0)
  )
);

-- The migration owner and the explicit non-owner BFF runtime role are the
-- only intended principals. Deployment grants SELECT to that runtime role;
-- this migration never grants batch mutation privileges to PUBLIC.
REVOKE ALL ON TABLE public.auth_migration_batches FROM PUBLIC;
COMMENT ON TABLE public.auth_migration_batches
  IS 'Migration readiness is owner-written and read-only to the explicitly granted non-owner BFF runtime role.';

COMMIT;
