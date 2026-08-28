BEGIN;

-- The first auth migration may already have been applied before the
-- environment/site boundary and authorization-version hardening landed.
-- Rebuild only the affected index so this migration is safe after either
-- the old or current definition.
DROP INDEX IF EXISTS public.auth_sessions_legacy_netlify_user_id_uidx;

CREATE UNIQUE INDEX auth_sessions_legacy_netlify_user_id_uidx
  ON public.auth_sessions (environment_id, site_id, legacy_netlify_user_id)
  WHERE legacy_netlify_user_id IS NOT NULL AND revoked_at IS NULL;

-- Keep the function signature stable for callers while ensuring every actual
-- role/status change invalidates sessions carrying the previous authz version.
CREATE OR REPLACE FUNCTION public.apply_account_authorization_mutation(
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
    RAISE EXCEPTION 'authorization target account does not exist'
      USING ERRCODE = '23503';
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

REVOKE EXECUTE ON FUNCTION public.apply_account_authorization_mutation(
  UUID, TEXT, UUID, public.auth_account_role, public.auth_account_status, JSONB
) FROM PUBLIC;

-- Older environments may have applied the initial auth migration before the
-- self-service VIP boundary was introduced. Recreate it here so applying this
-- incremental migration after either baseline shape converges to the same
-- guarded function set.
-- `CREATE OR REPLACE` cannot target a function that was absent from the old
-- already-applied migration. Bootstrap a same-signature placeholder only in
-- that case, then replace it with the guarded implementation below. This
-- keeps reruns privilege-preserving while allowing old schemas to converge.
DO $bootstrap_request_account_vip$
BEGIN
  IF pg_catalog.to_regprocedure('public.request_account_vip(uuid,jsonb)') IS NULL THEN
    EXECUTE $bootstrap_function$
      CREATE FUNCTION public.request_account_vip(
        p_account_id UUID,
        p_metadata JSONB DEFAULT '{}'::jsonb
      )
      RETURNS UUID
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $placeholder$
      BEGIN
        RAISE EXCEPTION 'request_account_vip bootstrap placeholder was not replaced'
          USING ERRCODE = 'XX000';
      END;
      $placeholder$;
    $bootstrap_function$;
  END IF;
END;
$bootstrap_request_account_vip$;

CREATE OR REPLACE FUNCTION public.request_account_vip(
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

  -- Pending/VIP/admin accounts are already at least as authorized as a
  -- request. Only an active free account transitions to pending.
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

REVOKE EXECUTE ON FUNCTION public.request_account_vip(UUID, JSONB) FROM PUBLIC;

COMMENT ON FUNCTION public.set_account_authorization(
  UUID, UUID, public.auth_account_role, public.auth_account_status, JSONB
)
  IS 'Validated authorization mutation boundary. Deployment must explicitly grant EXECUTE only to a non-owner application role.';

COMMENT ON FUNCTION public.request_account_vip(UUID, JSONB)
  IS 'Validated self-service VIP request boundary. Deployment must explicitly grant EXECUTE only to the trusted non-owner BFF role; never grant PUBLIC.';

COMMIT;
