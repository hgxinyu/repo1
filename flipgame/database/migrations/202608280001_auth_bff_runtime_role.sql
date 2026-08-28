BEGIN;

-- The application role is provisioned out-of-band by the database owner. This
-- migration deliberately never creates a role and never handles a password.
-- A missing or over-privileged role must stop deployment before any grants are
-- applied.
DO $$
DECLARE
  runtime_role_oid OID;
  runtime_role_super BOOLEAN;
  runtime_role_inherit BOOLEAN;
  runtime_role_create_role BOOLEAN;
  runtime_role_create_db BOOLEAN;
  runtime_role_replication BOOLEAN;
  runtime_role_bypass_rls BOOLEAN;
BEGIN
  SELECT oid,
         rolsuper,
         rolinherit,
         rolcreaterole,
         rolcreatedb,
         rolreplication,
         rolbypassrls
    INTO runtime_role_oid,
         runtime_role_super,
         runtime_role_inherit,
         runtime_role_create_role,
         runtime_role_create_db,
         runtime_role_replication,
         runtime_role_bypass_rls
    FROM pg_catalog.pg_roles
   WHERE rolname = 'shinegame_auth_bff';

  IF runtime_role_oid IS NULL THEN
    RAISE EXCEPTION
      'required runtime role "shinegame_auth_bff" is missing; provision it out-of-band without putting a password in this migration'
      USING ERRCODE = '42704',
            HINT = 'Create a dedicated non-owner NOINHERIT role, then rerun this migration.';
  END IF;

  IF runtime_role_super OR
     runtime_role_inherit OR
     runtime_role_create_role OR
     runtime_role_create_db OR
     runtime_role_replication OR
     runtime_role_bypass_rls THEN
    RAISE EXCEPTION
      'runtime role "shinegame_auth_bff" must be non-owner, NOINHERIT, and have no superuser, role-creation, database-creation, replication, or bypass-RLS capability'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members
     WHERE member = runtime_role_oid
  ) THEN
    RAISE EXCEPTION
      'runtime role "shinegame_auth_bff" must not be a member of another role'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS relation
     WHERE relation.relowner = runtime_role_oid
       AND relation.relnamespace = 'public'::pg_catalog.regnamespace
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS procedure
     WHERE procedure.proowner = runtime_role_oid
       AND procedure.pronamespace = 'public'::pg_catalog.regnamespace
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_type AS type
     WHERE type.typowner = runtime_role_oid
       AND type.typnamespace = 'public'::pg_catalog.regnamespace
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_namespace AS schema
     WHERE schema.oid = 'public'::pg_catalog.regnamespace
       AND schema.nspowner = runtime_role_oid
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_database AS database
     WHERE database.datdba = runtime_role_oid
  ) THEN
    RAISE EXCEPTION
      'runtime role "shinegame_auth_bff" must not own the database, public schema, or public application objects'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

-- Converge direct grants on every run. NOINHERIT plus the explicit revokes
-- ensure a stale direct grant cannot expand the application boundary.
REVOKE ALL ON SCHEMA public FROM shinegame_auth_bff;
GRANT USAGE ON SCHEMA public TO shinegame_auth_bff;

GRANT USAGE ON TYPE public.auth_account_role TO shinegame_auth_bff;
GRANT USAGE ON TYPE public.auth_account_status TO shinegame_auth_bff;
GRANT USAGE ON TYPE public.auth_identity_status TO shinegame_auth_bff;
GRANT USAGE ON TYPE public.auth_session_source TO shinegame_auth_bff;
GRANT USAGE ON TYPE public.auth_transaction_kind TO shinegame_auth_bff;
GRANT USAGE ON TYPE public.auth_migration_status TO shinegame_auth_bff;
GRANT USAGE ON TYPE public.auth_merge_status TO shinegame_auth_bff;

REVOKE ALL ON TABLE public.accounts FROM shinegame_auth_bff;
REVOKE ALL ON TABLE public.account_emails FROM shinegame_auth_bff;
REVOKE ALL ON TABLE public.auth_identities FROM shinegame_auth_bff;
REVOKE ALL ON TABLE public.auth_sessions FROM shinegame_auth_bff;
REVOKE ALL ON TABLE public.oauth_transactions FROM shinegame_auth_bff;
REVOKE ALL ON TABLE public.ai_hourly_limits FROM shinegame_auth_bff;
REVOKE ALL ON TABLE public.migration_records FROM shinegame_auth_bff;
REVOKE ALL ON TABLE public.auth_migration_batches FROM shinegame_auth_bff;
REVOKE ALL ON TABLE public.account_authorization_audit FROM shinegame_auth_bff;
REVOKE ALL ON TABLE public.auth_authorization_mutation_context FROM shinegame_auth_bff;
REVOKE ALL ON TABLE public.account_merge_operations FROM shinegame_auth_bff;

-- Reads are needed by account/session resolution and admin list rendering.
-- No table contains plaintext email or provider tokens; encrypted values remain
-- encrypted at rest and are only selected by the BFF for server-side use.
GRANT SELECT ON TABLE public.accounts TO shinegame_auth_bff;
GRANT SELECT ON TABLE public.account_emails TO shinegame_auth_bff;
GRANT SELECT ON TABLE public.auth_identities TO shinegame_auth_bff;
GRANT SELECT ON TABLE public.auth_sessions TO shinegame_auth_bff;
GRANT SELECT ON TABLE public.oauth_transactions TO shinegame_auth_bff;
GRANT SELECT ON TABLE public.ai_hourly_limits TO shinegame_auth_bff;
GRANT SELECT ON TABLE public.migration_records TO shinegame_auth_bff;
GRANT SELECT ON TABLE public.auth_migration_batches TO shinegame_auth_bff;

-- Account creation is a SECURITY DEFINER boundary. The BFF can provide only
-- profile text; role and status are fixed in the function body so a compromised
-- runtime cannot create an admin, VIP, blocked, or otherwise privileged row.
CREATE FUNCTION public.create_free_account(
  p_guild TEXT,
  p_game_name TEXT
)
RETURNS TABLE (
  account_id UUID,
  role public.auth_account_role,
  status public.auth_account_status,
  guild TEXT,
  game_name TEXT,
  authz_version BIGINT,
  merged_into_account_id UUID,
  migration_id UUID,
  blocked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
  INSERT INTO public.accounts (role, status, guild, game_name)
  VALUES (
    'free'::public.auth_account_role,
    'active'::public.auth_account_status,
    p_guild,
    p_game_name
  )
  RETURNING
    public.accounts.account_id,
    public.accounts.role,
    public.accounts.status,
    public.accounts.guild,
    public.accounts.game_name,
    public.accounts.authz_version,
    public.accounts.merged_into_account_id,
    public.accounts.migration_id,
    public.accounts.blocked_at,
    public.accounts.created_at,
    public.accounts.updated_at;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_free_account(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_free_account(TEXT, TEXT) TO shinegame_auth_bff;

-- Profile fields are the only direct account updates; authorization changes use
-- the separate SECURITY DEFINER function below.
GRANT UPDATE (guild, game_name, updated_at) ON TABLE public.accounts TO shinegame_auth_bff;

GRANT INSERT (
  account_id,
  email_lookup_hash,
  encrypted_email,
  encryption_key_version,
  is_primary,
  verified_at
) ON TABLE public.account_emails TO shinegame_auth_bff;

GRANT INSERT (
  account_id,
  issuer_or_tenant,
  connector_scope,
  provider_subject,
  subject_type,
  logto_user_id
) ON TABLE public.auth_identities TO shinegame_auth_bff;

GRANT INSERT (
  transaction_kind,
  state_hash,
  nonce_hash,
  nonce_encrypted,
  pkce_verifier_encrypted,
  csrf_token_hash,
  environment_id,
  site_id,
  next_path,
  account_id,
  legacy_session_id_hash,
  migration_id,
  created_at,
  expires_at
) ON TABLE public.oauth_transactions TO shinegame_auth_bff;
GRANT UPDATE (consumed_at) ON TABLE public.oauth_transactions TO shinegame_auth_bff;

GRANT INSERT (
  auth_source,
  environment_id,
  site_id,
  session_id_hash,
  session_family_id,
  account_id,
  logto_subject,
  legacy_netlify_user_id,
  migration_id,
  encrypted_refresh_token,
  refresh_token_key_version,
  issued_at,
  last_seen_at,
  idle_expires_at,
  absolute_expires_at,
  authz_version,
  rotation_version,
  created_at
) ON TABLE public.auth_sessions TO shinegame_auth_bff;
GRANT UPDATE (
  revoked_at,
  encrypted_refresh_token,
  refresh_token_key_version,
  rotation_version,
  last_seen_at,
  idle_expires_at
) ON TABLE public.auth_sessions TO shinegame_auth_bff;

GRANT INSERT (account_id, hour_start, count) ON TABLE public.ai_hourly_limits TO shinegame_auth_bff;
GRANT UPDATE (count, updated_at) ON TABLE public.ai_hourly_limits TO shinegame_auth_bff;

-- Read-only migration evidence. Import, reconcile, and finalize continue to
-- require the database owner and are intentionally absent from this role.
-- The three tables below are authorization/audit or future merge state and are
-- not directly reachable by the BFF.

-- SECURITY DEFINER is intentionally limited to the two validated application
-- operations. PUBLIC and every other application role retain no execute path.
REVOKE EXECUTE ON FUNCTION public.auth_current_actor() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.prevent_account_authorization_audit_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.enforce_account_authorization_audit_actor() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_account_authorization_change() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.apply_account_authorization_mutation(
  UUID, TEXT, UUID, public.auth_account_role, public.auth_account_status, JSONB
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.request_account_vip(UUID, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_account_authorization(
  UUID, UUID, public.auth_account_role, public.auth_account_status, JSONB
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_system_account_authorization(
  UUID, public.auth_account_role, public.auth_account_status, JSONB
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.request_account_vip(UUID, JSONB) TO shinegame_auth_bff;
GRANT EXECUTE ON FUNCTION public.set_account_authorization(
  UUID, UUID, public.auth_account_role, public.auth_account_status, JSONB
) TO shinegame_auth_bff;

COMMENT ON ROLE shinegame_auth_bff IS
  'ShineGame BFF runtime role: non-owner, NOINHERIT, no password managed by migrations, and limited to auth/session/account runtime paths.';

COMMIT;
