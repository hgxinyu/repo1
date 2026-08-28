BEGIN;

-- `current_role` is a PostgreSQL special expression of type `name`. Using it
-- as an unqualified PL/pgSQL variable caused enum comparisons in this function
-- to resolve as `name = auth_account_role`. Prefix local variables so both
-- existing databases and fresh installs execute the self-service boundary.
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

COMMENT ON FUNCTION public.request_account_vip(UUID, JSONB)
  IS 'Validated self-service VIP request boundary. Deployment must explicitly grant EXECUTE only to the trusted non-owner BFF role; never grant PUBLIC.';

COMMIT;
