BEGIN;

CREATE TYPE auth_account_role AS ENUM (
  'pending',
  'free',
  'vip',
  'admin',
  'blocked'
);

CREATE TYPE auth_account_status AS ENUM (
  'active',
  'blocked',
  'merged',
  'disabled'
);

CREATE TYPE auth_identity_status AS ENUM (
  'pending',
  'active',
  'revoked'
);

CREATE TYPE auth_session_source AS ENUM (
  'logto',
  'legacy_bridge'
);

CREATE TYPE auth_transaction_kind AS ENUM (
  'oauth',
  'bridge'
);

CREATE TYPE auth_migration_status AS ENUM (
  'pending',
  'frozen',
  'imported',
  'reconciled',
  'failed',
  'conflict'
);

CREATE TYPE auth_merge_status AS ENUM (
  'pending',
  'verified',
  'locked',
  'linking',
  'account_committed',
  'duplicate_disabled',
  'completed',
  'needs_repair',
  'needs_manual_repair'
);

CREATE TABLE auth_migration_batches (
  batch_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  snapshot_hash BYTEA NOT NULL CHECK (octet_length(snapshot_hash) = 32),
  status auth_migration_status NOT NULL DEFAULT 'pending',
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

CREATE TABLE accounts (
  account_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role auth_account_role NOT NULL DEFAULT 'pending',
  status auth_account_status NOT NULL DEFAULT 'active',
  guild TEXT,
  game_name TEXT,
  authz_version BIGINT NOT NULL DEFAULT 1 CHECK (authz_version > 0),
  merged_into_account_id UUID REFERENCES accounts(account_id) ON DELETE RESTRICT,
  migration_id UUID,
  blocked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (NOT (role = 'blocked' AND status <> 'blocked')),
  CHECK (status <> 'blocked' OR blocked_at IS NOT NULL),
  CHECK (merged_into_account_id IS NULL OR merged_into_account_id <> account_id),
  CHECK (merged_into_account_id IS NULL OR status = 'merged')
);

CREATE TABLE account_authorization_audit (
  audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_account_id UUID REFERENCES accounts(account_id) ON DELETE RESTRICT,
  actor_source TEXT NOT NULL,
  target_account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE RESTRICT,
  old_role auth_account_role NOT NULL,
  new_role auth_account_role NOT NULL,
  old_status auth_account_status NOT NULL,
  new_status auth_account_status NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT account_authorization_audit_actor_check CHECK (
    (actor_source = 'account' AND actor_account_id IS NOT NULL) OR
    (actor_source = 'system' AND actor_account_id IS NULL)
  ),
  CONSTRAINT account_authorization_audit_change_check CHECK (
    old_role <> new_role OR old_status <> new_status
  ),
  CONSTRAINT account_authorization_audit_metadata_check CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX account_authorization_audit_target_idx
  ON account_authorization_audit (target_account_id, changed_at DESC);

CREATE INDEX account_authorization_audit_actor_idx
  ON account_authorization_audit (actor_account_id, changed_at DESC);

CREATE TABLE auth_authorization_mutation_context (
  backend_pid INTEGER NOT NULL,
  transaction_id BIGINT NOT NULL,
  mutation_token UUID NOT NULL,
  actor_account_id UUID REFERENCES accounts(account_id) ON DELETE RESTRICT,
  actor_source TEXT NOT NULL,
  target_account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE RESTRICT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (backend_pid, transaction_id),
  UNIQUE (mutation_token),
  CONSTRAINT auth_authorization_mutation_context_actor_check CHECK (
    (actor_source = 'account' AND actor_account_id IS NOT NULL) OR
    (actor_source = 'system' AND actor_account_id IS NULL)
  ),
  CONSTRAINT auth_authorization_mutation_context_metadata_check CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE FUNCTION public.auth_current_actor()
RETURNS TABLE (
  actor_account_id UUID,
  actor_source TEXT,
  target_account_id UUID,
  metadata JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_token TEXT := NULLIF(pg_catalog.current_setting('app.authz_mutation_token', true), '');
BEGIN
  SELECT context.actor_account_id,
         context.actor_source,
         context.target_account_id,
         context.metadata
    INTO actor_account_id,
         actor_source,
         target_account_id,
         metadata
    FROM public.auth_authorization_mutation_context AS context
   WHERE context.backend_pid = pg_catalog.pg_backend_pid()
     AND context.transaction_id = pg_catalog.txid_current()
     AND context.mutation_token::TEXT = current_token;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'accounts role/status update requires the controlled authorization boundary'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEXT;
END;
$$;

CREATE FUNCTION public.prevent_account_authorization_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'account_authorization_audit is append-only; % is not allowed', TG_OP
    USING ERRCODE = '55006';
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.enforce_account_authorization_audit_actor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  expected_account_id UUID;
  expected_source TEXT;
  expected_target_id UUID;
BEGIN
  IF pg_catalog.pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'account_authorization_audit inserts are only allowed from the accounts authorization trigger'
      USING ERRCODE = '42501';
  END IF;

  SELECT current_actor.actor_account_id,
         current_actor.actor_source,
         current_actor.target_account_id
    INTO expected_account_id,
         expected_source,
         expected_target_id
    FROM public.auth_current_actor() AS current_actor;
  IF NEW.actor_account_id IS DISTINCT FROM expected_account_id OR
     NEW.actor_source IS DISTINCT FROM expected_source OR
     NEW.target_account_id IS DISTINCT FROM expected_target_id THEN
    RAISE EXCEPTION 'account_authorization_audit actor does not match the controlled authorization boundary'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.record_account_authorization_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_actor_id UUID;
  current_actor_source TEXT;
  current_target_id UUID;
  current_metadata JSONB;
BEGIN
  SELECT current_actor.actor_account_id,
         current_actor.actor_source,
         current_actor.target_account_id,
         current_actor.metadata
    INTO current_actor_id,
         current_actor_source,
         current_target_id,
         current_metadata
    FROM public.auth_current_actor() AS current_actor;
  IF current_target_id IS DISTINCT FROM NEW.account_id THEN
    RAISE EXCEPTION 'authorization mutation target does not match the accounts trigger row'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.account_authorization_audit (
    actor_account_id,
    actor_source,
    target_account_id,
    old_role,
    new_role,
    old_status,
    new_status,
    metadata
  )
  VALUES (
    current_actor_id,
    current_actor_source,
    NEW.account_id,
    OLD.role,
    NEW.role,
    OLD.status,
    NEW.status,
    current_metadata || pg_catalog.jsonb_build_object('source', 'accounts_authorization_trigger')
  );
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.apply_account_authorization_mutation(
  p_actor_account_id UUID,
  p_actor_source TEXT,
  p_target_account_id UUID,
  p_new_role public.auth_account_role,
  p_new_status public.auth_account_status,
  p_metadata JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_mutation_token UUID := pg_catalog.gen_random_uuid();
  old_role public.auth_account_role;
  old_status public.auth_account_status;
BEGIN
  IF p_actor_source NOT IN ('account', 'system') THEN
    RAISE EXCEPTION 'authorization actor source is invalid' USING ERRCODE = '22023';
  END IF;
  IF (p_actor_source = 'account' AND p_actor_account_id IS NULL) OR
     (p_actor_source = 'system' AND p_actor_account_id IS NOT NULL) THEN
    RAISE EXCEPTION 'authorization actor source and account must agree' USING ERRCODE = '22023';
  END IF;
  IF p_metadata IS NULL OR pg_catalog.jsonb_typeof(p_metadata) <> 'object' THEN
    RAISE EXCEPTION 'authorization metadata must be a JSON object' USING ERRCODE = '22023';
  END IF;

  SELECT account.role, account.status
    INTO old_role, old_status
    FROM public.accounts AS account
   WHERE account.account_id = p_target_account_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'authorization target account does not exist' USING ERRCODE = '23503';
  END IF;

  IF old_role IS NOT DISTINCT FROM p_new_role AND
     old_status IS NOT DISTINCT FROM p_new_status THEN
    PERFORM pg_catalog.set_config('app.authz_mutation_token', '', true);
    RETURN p_target_account_id;
  END IF;

  INSERT INTO public.auth_authorization_mutation_context (
    backend_pid,
    transaction_id,
    mutation_token,
    actor_account_id,
    actor_source,
    target_account_id,
    metadata
  )
  VALUES (
    pg_catalog.pg_backend_pid(),
    pg_catalog.txid_current(),
    current_mutation_token,
    p_actor_account_id,
    p_actor_source,
    p_target_account_id,
    p_metadata
  );
  PERFORM pg_catalog.set_config('app.authz_mutation_token', current_mutation_token::TEXT, true);

  UPDATE public.accounts
     SET role = p_new_role,
         status = p_new_status,
         authz_version = authz_version + 1,
         blocked_at = CASE
           WHEN p_new_status = 'blocked'::public.auth_account_status
             THEN COALESCE(blocked_at, pg_catalog.now())
           ELSE NULL
         END,
         updated_at = pg_catalog.now()
   WHERE account_id = p_target_account_id;

  DELETE FROM public.auth_authorization_mutation_context
   WHERE backend_pid = pg_catalog.pg_backend_pid()
     AND transaction_id = pg_catalog.txid_current()
     AND mutation_token = current_mutation_token;
  PERFORM pg_catalog.set_config('app.authz_mutation_token', '', true);
  RETURN p_target_account_id;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM public.auth_authorization_mutation_context
   WHERE backend_pid = pg_catalog.pg_backend_pid()
     AND transaction_id = pg_catalog.txid_current()
     AND mutation_token = current_mutation_token;
  PERFORM pg_catalog.set_config('app.authz_mutation_token', '', true);
  RAISE;
END;
$$;

CREATE FUNCTION public.request_account_vip(
  p_account_id UUID,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_current_role public.auth_account_role;
  v_current_status public.auth_account_status;
BEGIN
  IF p_metadata IS NULL OR pg_catalog.jsonb_typeof(p_metadata) <> 'object' THEN
    RAISE EXCEPTION 'authorization metadata must be a JSON object' USING ERRCODE = '22023';
  END IF;

  SELECT account.role, account.status
    INTO v_current_role, v_current_status
    FROM public.accounts AS account
   WHERE account.account_id = p_account_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VIP request account does not exist' USING ERRCODE = '23503';
  END IF;
  IF v_current_status <> 'active'::public.auth_account_status THEN
    RAISE EXCEPTION 'VIP request requires an active account' USING ERRCODE = '42501';
  END IF;

  -- Existing pending/VIP/admin accounts are already at least as authorized as
  -- a request and remain idempotent. Only an active free account transitions.
  IF v_current_role IN (
    'pending'::public.auth_account_role,
    'vip'::public.auth_account_role,
    'admin'::public.auth_account_role
  ) THEN
    RETURN p_account_id;
  END IF;
  IF v_current_role <> 'free'::public.auth_account_role THEN
    RAISE EXCEPTION 'VIP request requires a free account' USING ERRCODE = '42501';
  END IF;

  RETURN public.apply_account_authorization_mutation(
    p_account_id,
    'account',
    p_account_id,
    'pending'::public.auth_account_role,
    'active'::public.auth_account_status,
    p_metadata
  );
END;
$$;

CREATE FUNCTION public.set_account_authorization(
  p_actor_account_id UUID,
  p_target_account_id UUID,
  p_new_role public.auth_account_role,
  p_new_status public.auth_account_status,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_role public.auth_account_role;
  actor_status public.auth_account_status;
BEGIN
  SELECT account.role, account.status
    INTO actor_role, actor_status
    FROM public.accounts AS account
   WHERE account.account_id = p_actor_account_id
   FOR SHARE;
  IF NOT FOUND OR actor_role <> 'admin'::public.auth_account_role OR
     actor_status <> 'active'::public.auth_account_status THEN
    RAISE EXCEPTION 'set_account_authorization requires an active admin actor'
      USING ERRCODE = '42501';
  END IF;

  RETURN public.apply_account_authorization_mutation(
    p_actor_account_id,
    'account',
    p_target_account_id,
    p_new_role,
    p_new_status,
    p_metadata
  );
END;
$$;

CREATE FUNCTION public.set_system_account_authorization(
  p_target_account_id UUID,
  p_new_role public.auth_account_role,
  p_new_status public.auth_account_status,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN public.apply_account_authorization_mutation(
    NULL,
    'system',
    p_target_account_id,
    p_new_role,
    p_new_status,
    p_metadata
  );
END;
$$;

CREATE TRIGGER account_authorization_audit_actor_guard
BEFORE INSERT ON public.account_authorization_audit
FOR EACH ROW
EXECUTE FUNCTION public.enforce_account_authorization_audit_actor();

CREATE TRIGGER account_authorization_audit_append_only
BEFORE UPDATE OR DELETE ON public.account_authorization_audit
FOR EACH ROW
EXECUTE FUNCTION public.prevent_account_authorization_audit_mutation();

CREATE TRIGGER account_authorization_audit_truncate_guard
BEFORE TRUNCATE ON public.account_authorization_audit
FOR EACH STATEMENT
EXECUTE FUNCTION public.prevent_account_authorization_audit_mutation();

CREATE TRIGGER accounts_authorization_audit_trigger
AFTER UPDATE OF role, status ON public.accounts
FOR EACH ROW
WHEN (OLD.role IS DISTINCT FROM NEW.role OR OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION public.record_account_authorization_change();

CREATE TABLE migration_records (
  migration_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL CHECK (btrim(source) <> ''),
  source_user_id TEXT NOT NULL CHECK (
    btrim(source_user_id) <> '' AND
    length(source_user_id) BETWEEN 1 AND 512
  ),
  legacy_netlify_user_id TEXT NOT NULL CHECK (
    btrim(legacy_netlify_user_id) <> '' AND
    length(legacy_netlify_user_id) BETWEEN 1 AND 255
  ),
  account_id UUID REFERENCES accounts(account_id) ON DELETE RESTRICT,
  legacy_email_lookup_hash BYTEA CHECK (
    legacy_email_lookup_hash IS NULL OR octet_length(legacy_email_lookup_hash) BETWEEN 16 AND 128
  ),
  snapshot_hash BYTEA NOT NULL CHECK (octet_length(snapshot_hash) BETWEEN 16 AND 128),
  status auth_migration_status NOT NULL DEFAULT 'pending',
  error_code TEXT,
  freeze_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (source, source_user_id),
  CHECK (completed_at IS NULL OR completed_at >= created_at)
);

ALTER TABLE accounts
  ADD CONSTRAINT accounts_migration_id_fkey
  FOREIGN KEY (migration_id)
  REFERENCES migration_records(migration_id)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE account_emails (
  email_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE RESTRICT,
  email_lookup_hash BYTEA NOT NULL CHECK (octet_length(email_lookup_hash) BETWEEN 16 AND 128),
  encrypted_email BYTEA NOT NULL CONSTRAINT account_emails_encrypted_email_check
    CHECK (octet_length(encrypted_email) BETWEEN 1 AND 8192),
  encryption_key_version INTEGER NOT NULL DEFAULT 1 CHECK (encryption_key_version > 0),
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at TIMESTAMPTZ,
  removed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (removed_at IS NULL OR removed_at >= created_at)
);

CREATE UNIQUE INDEX account_emails_lookup_uidx
  ON account_emails (email_lookup_hash)
  WHERE removed_at IS NULL;

CREATE UNIQUE INDEX account_emails_active_primary_uidx
  ON account_emails (account_id)
  WHERE is_primary AND removed_at IS NULL;

CREATE TABLE auth_identities (
  identity_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE RESTRICT,
  issuer_or_tenant TEXT NOT NULL CHECK (btrim(issuer_or_tenant) <> ''),
  connector_scope TEXT NOT NULL CHECK (btrim(connector_scope) <> ''),
  provider_subject TEXT NOT NULL CHECK (
    btrim(provider_subject) <> '' AND
    length(provider_subject) BETWEEN 1 AND 512
  ),
  subject_type TEXT NOT NULL CHECK (
    subject_type IN ('sub', 'openid', 'unionid') OR btrim(subject_type) <> ''
  ),
  logto_user_id TEXT CHECK (logto_user_id IS NULL OR length(logto_user_id) BETWEEN 1 AND 512),
  status auth_identity_status NOT NULL DEFAULT 'active',
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (status = 'revoked' AND revoked_at IS NOT NULL) OR
    (status <> 'revoked' AND revoked_at IS NULL)
  )
);

CREATE UNIQUE INDEX auth_identities_scope_subject_uidx
  ON auth_identities (issuer_or_tenant, connector_scope, provider_subject)
  WHERE revoked_at IS NULL;

CREATE INDEX auth_identities_account_idx
  ON auth_identities (account_id)
  WHERE revoked_at IS NULL;

CREATE TABLE auth_sessions (
  session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_source auth_session_source NOT NULL,
  environment_id TEXT NOT NULL CHECK (
    btrim(environment_id) <> '' AND length(environment_id) BETWEEN 1 AND 128
  ),
  site_id TEXT NOT NULL CHECK (
    btrim(site_id) <> '' AND length(site_id) BETWEEN 1 AND 255
  ),
  session_id_hash BYTEA NOT NULL CHECK (octet_length(session_id_hash) BETWEEN 16 AND 128),
  session_family_id UUID NOT NULL DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE RESTRICT,
  logto_subject TEXT CHECK (logto_subject IS NULL OR length(logto_subject) BETWEEN 1 AND 512),
  legacy_netlify_user_id TEXT CHECK (
    legacy_netlify_user_id IS NULL OR
    length(legacy_netlify_user_id) BETWEEN 1 AND 255
  ),
  migration_id UUID REFERENCES migration_records(migration_id) ON DELETE RESTRICT,
  encrypted_refresh_token BYTEA CHECK (
    encrypted_refresh_token IS NULL OR octet_length(encrypted_refresh_token) BETWEEN 1 AND 8192
  ),
  refresh_token_key_version INTEGER,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idle_expires_at TIMESTAMPTZ NOT NULL,
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  authz_version BIGINT NOT NULL DEFAULT 1 CHECK (authz_version > 0),
  rotation_version BIGINT NOT NULL DEFAULT 1 CHECK (rotation_version > 0),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id_hash),
  CHECK (
    (auth_source = 'logto' AND logto_subject IS NOT NULL AND legacy_netlify_user_id IS NULL) OR
    (auth_source = 'legacy_bridge' AND logto_subject IS NULL AND legacy_netlify_user_id IS NOT NULL AND encrypted_refresh_token IS NULL)
  ),
  CONSTRAINT auth_sessions_refresh_token_pair_check CHECK (
    (encrypted_refresh_token IS NULL AND refresh_token_key_version IS NULL) OR
    (encrypted_refresh_token IS NOT NULL AND refresh_token_key_version IS NOT NULL AND refresh_token_key_version > 0)
  ),
  CHECK (idle_expires_at > created_at AND absolute_expires_at >= idle_expires_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX auth_sessions_account_active_idx
  ON auth_sessions (account_id, absolute_expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX auth_sessions_family_active_idx
  ON auth_sessions (session_family_id, absolute_expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX auth_sessions_environment_active_idx
  ON auth_sessions (environment_id, site_id, absolute_expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX auth_sessions_environment_family_active_idx
  ON auth_sessions (environment_id, site_id, session_family_id, absolute_expires_at)
  WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX auth_sessions_legacy_netlify_user_id_uidx
  ON auth_sessions (environment_id, site_id, legacy_netlify_user_id)
  WHERE legacy_netlify_user_id IS NOT NULL AND revoked_at IS NULL;

CREATE TABLE oauth_transactions (
  transaction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_kind auth_transaction_kind NOT NULL,
  state_hash BYTEA NOT NULL CHECK (octet_length(state_hash) BETWEEN 16 AND 128),
  nonce_hash BYTEA CHECK (nonce_hash IS NULL OR octet_length(nonce_hash) BETWEEN 16 AND 128),
  nonce_encrypted BYTEA CHECK (
    nonce_encrypted IS NULL OR octet_length(nonce_encrypted) BETWEEN 1 AND 8192
  ),
  pkce_verifier_encrypted BYTEA CHECK (
    pkce_verifier_encrypted IS NULL OR octet_length(pkce_verifier_encrypted) BETWEEN 1 AND 8192
  ),
  csrf_token_hash BYTEA CHECK (
    csrf_token_hash IS NULL OR octet_length(csrf_token_hash) BETWEEN 16 AND 128
  ),
  environment_id TEXT NOT NULL CHECK (btrim(environment_id) <> ''),
  site_id TEXT NOT NULL CHECK (btrim(site_id) <> ''),
  next_path TEXT NOT NULL,
  account_id UUID REFERENCES accounts(account_id) ON DELETE RESTRICT,
  legacy_session_id_hash BYTEA CHECK (
    legacy_session_id_hash IS NULL OR octet_length(legacy_session_id_hash) BETWEEN 16 AND 128
  ),
  migration_id UUID REFERENCES migration_records(migration_id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  UNIQUE (state_hash),
  CONSTRAINT oauth_transactions_next_path_check CHECK (
    length(next_path) BETWEEN 1 AND 2048 AND
    next_path LIKE '/%' AND
    next_path NOT LIKE '//%' AND
    next_path NOT LIKE '%:%' AND
    next_path !~ E'[[:cntrl:]]' AND
    next_path NOT LIKE '%\\%'
  ),
  CONSTRAINT oauth_transactions_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT oauth_transactions_ttl_check CHECK (
    (transaction_kind = 'oauth' AND expires_at <= created_at + INTERVAL '10 minutes') OR
    (transaction_kind = 'bridge' AND expires_at <= created_at + INTERVAL '5 minutes')
  ),
  CONSTRAINT oauth_transactions_credentials_check CHECK (
    (transaction_kind = 'oauth' AND
      state_hash IS NOT NULL AND
      nonce_hash IS NOT NULL AND
      nonce_encrypted IS NOT NULL AND
      pkce_verifier_encrypted IS NOT NULL AND
      legacy_session_id_hash IS NULL AND
      csrf_token_hash IS NULL) OR
    (transaction_kind = 'bridge' AND
      state_hash IS NOT NULL AND
      legacy_session_id_hash IS NOT NULL AND
      csrf_token_hash IS NOT NULL AND
      nonce_hash IS NULL AND
      nonce_encrypted IS NULL AND
      pkce_verifier_encrypted IS NULL AND
      account_id IS NOT NULL AND
      migration_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX oauth_transactions_active_state_uidx
  ON oauth_transactions (state_hash)
  WHERE consumed_at IS NULL;

CREATE INDEX oauth_transactions_expiry_idx
  ON oauth_transactions (expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE account_merge_operations (
  merge_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE RESTRICT,
  target_account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE RESTRICT,
  requested_by_account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE RESTRICT,
  status auth_merge_status NOT NULL DEFAULT 'pending',
  idempotency_key TEXT NOT NULL CHECK (btrim(idempotency_key) <> ''),
  source_snapshot_hash BYTEA NOT NULL CHECK (octet_length(source_snapshot_hash) BETWEEN 16 AND 128),
  target_snapshot_hash BYTEA NOT NULL CHECK (octet_length(target_snapshot_hash) BETWEEN 16 AND 128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (idempotency_key),
  CHECK (source_account_id <> target_account_id),
  CHECK (completed_at IS NULL OR completed_at >= created_at)
);

CREATE UNIQUE INDEX account_merge_operations_active_source_uidx
  ON account_merge_operations (source_account_id)
  WHERE status NOT IN ('completed', 'needs_repair', 'needs_manual_repair');

CREATE INDEX account_merge_operations_target_idx
  ON account_merge_operations (target_account_id, updated_at DESC);

CREATE TABLE ai_hourly_limits (
  account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE RESTRICT,
  hour_start TIMESTAMPTZ NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, hour_start),
  CHECK (hour_start = date_trunc('hour', hour_start))
);

CREATE INDEX ai_hourly_limits_expiry_idx
  ON ai_hourly_limits (hour_start);

-- Authorization writes are intentionally exposed only through the validated
-- SECURITY DEFINER boundary. Deployment must grant this function to a
-- non-owner application role; the migration does not assume a role name.
-- Migration-batch readiness follows the same owner/BFF boundary: the owner
-- creates and finalizes rows, while deployment explicitly grants SELECT only
-- to the trusted non-owner BFF runtime role.
REVOKE ALL ON TABLE public.auth_migration_batches FROM PUBLIC;
COMMENT ON TABLE public.auth_migration_batches
  IS 'Migration readiness is owner-written and read-only to the explicitly granted non-owner BFF runtime role.';
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.account_authorization_audit FROM PUBLIC;
REVOKE ALL ON TABLE public.auth_authorization_mutation_context FROM PUBLIC;
REVOKE UPDATE (role, status) ON TABLE public.accounts FROM PUBLIC;
REVOKE UPDATE (blocked_at) ON TABLE public.accounts FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.auth_current_actor() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.enforce_account_authorization_audit_actor() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.prevent_account_authorization_audit_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_account_authorization_change() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.apply_account_authorization_mutation(UUID, TEXT, UUID, public.auth_account_role, public.auth_account_status, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.request_account_vip(UUID, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_account_authorization(UUID, UUID, public.auth_account_role, public.auth_account_status, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_system_account_authorization(UUID, public.auth_account_role, public.auth_account_status, JSONB) FROM PUBLIC;

COMMENT ON FUNCTION public.set_account_authorization(UUID, UUID, public.auth_account_role, public.auth_account_status, JSONB)
  IS 'Validated authorization mutation boundary. Deployment must explicitly grant EXECUTE only to a non-owner application role.';

COMMENT ON FUNCTION public.request_account_vip(UUID, JSONB)
  IS 'Validated self-service VIP request boundary. Deployment must explicitly grant EXECUTE only to the trusted non-owner BFF role; never grant PUBLIC.';

COMMIT;
