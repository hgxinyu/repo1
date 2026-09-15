BEGIN;

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_login_country TEXT,
  ADD COLUMN IF NOT EXISTS last_login_region TEXT,
  ADD COLUMN IF NOT EXISTS last_login_city TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.accounts'::pg_catalog.regclass
       AND conname = 'accounts_last_login_country_check'
  ) THEN
    ALTER TABLE public.accounts
      ADD CONSTRAINT accounts_last_login_country_check CHECK (
        last_login_country IS NULL OR
        (btrim(last_login_country) <> '' AND length(last_login_country) BETWEEN 1 AND 128)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.accounts'::pg_catalog.regclass
       AND conname = 'accounts_last_login_region_check'
  ) THEN
    ALTER TABLE public.accounts
      ADD CONSTRAINT accounts_last_login_region_check CHECK (
        last_login_region IS NULL OR
        (btrim(last_login_region) <> '' AND length(last_login_region) BETWEEN 1 AND 128)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.accounts'::pg_catalog.regclass
       AND conname = 'accounts_last_login_city_check'
  ) THEN
    ALTER TABLE public.accounts
      ADD CONSTRAINT accounts_last_login_city_check CHECK (
        last_login_city IS NULL OR
        (btrim(last_login_city) <> '' AND length(last_login_city) BETWEEN 1 AND 128)
      );
  END IF;
END;
$$;

REVOKE UPDATE (last_login_at, last_login_country, last_login_region, last_login_city)
  ON TABLE public.accounts FROM PUBLIC;
GRANT UPDATE (last_login_at, last_login_country, last_login_region, last_login_city)
  ON TABLE public.accounts TO shinegame_auth_bff;

COMMENT ON COLUMN public.accounts.last_login_at IS
  'UTC timestamp of the most recent successful first-party app session creation.';
COMMENT ON COLUMN public.accounts.last_login_country IS
  'Coarse country code from trusted platform geo metadata; raw IP is not stored.';
COMMENT ON COLUMN public.accounts.last_login_region IS
  'Coarse region from trusted platform geo metadata.';
COMMENT ON COLUMN public.accounts.last_login_city IS
  'Coarse city from trusted platform geo metadata.';

COMMIT;
