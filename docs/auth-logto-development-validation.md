# Logto Development Validation

Status: **TASK 5 LOCAL-TEST IMPLEMENTED/VALIDATED — Google legacy claim, repeat login, readiness matrix, and migration smoke passed; real email OTP delivery/callback and genuinely fresh-profile HTTPS stage acceptance remain production release gates**

Final whole-branch hardening is implemented locally but does not change those release gates. Production import and finalization share one source/environment/site advisory lock: import rejects a reconciled/completed scope before any row write, while finalization locks and exactly compares the full source/snapshot migration population and validates ordered completion evidence plus the account/email/identity graph before persisting the batch in that same owner transaction. The module constructs and deep-freezes its report and completion time internally. Caller-supplied, serialized, read-only-diagnostic, or imported-file evidence is rejected. Legacy emails without explicit verified evidence are conflicts, and sensitive snapshot/review files use exclusive `0600` creation with redacted stdout.

This evidence applies only to the free `Shinegame Dev` Logto tenant and synthetic development users. It does not authorize production use, deployment, user import, shared-data writes, or production callback domains.

## Redacted resource inventory

- Logto issuer: `https://5geg1s.logto.app/oidc`
- Traditional web application: `ShineGame Web Dev`
- Application ID: `v4gi366vxzgyxu3fydn8v`
- Local redirect URI: `http://localhost:8888/api/auth/callback`
- Local post sign-out URI: `http://localhost:8888/`
- Local CORS origin: `http://localhost:8888`
- Stage redirect URI: **PENDING — `AUTH_STAGE_CALLBACK_URL` is not configured**
- Provider token storage / unconditional refresh token issuance: disabled
- First-party OIDC offline access: requested with `scope=offline_access` and standards-compliant `prompt=consent`
- OAuth 2.0 Token Exchange grant: disabled; authorization-code exchange remains enabled and is validated below

No client secret, provider secret, authorization code, access token, refresh token, verification code, or full callback query is recorded here.

## Hosted UI and connectors

| Method | Development configuration | Validation status |
|---|---|---|
| Email OTP | Logto email service; email is the sign-up identifier; verification is required; password creation and password sign-in are disabled; verification-code sign-in is enabled | Configuration verified; synthetic delivery/callback **PENDING** |
| Google | Self-owned Google Cloud Web client connected to Logto; External / Testing; provider-token storage and offline access disabled | Configuration, credential rotation, first sign-in, and repeat sign-in **PASS** |
| QQ | Paused by product decision because the owner cannot currently complete QQ Connect login | **DEFERRED**; no QQ connector was saved and QQ is not a release gate for the first rollout |
| WeChat | Not configured | **FUTURE CANDIDATE** only; feasibility, account eligibility, approval, subject semantics, and connector scope must be researched and validated before adding it to scope |

The Logto Google Demo connector was removed and replaced with a self-owned development connector:

- Google Cloud project: `ShineGame Auth Dev` (`shinegame-auth-dev`)
- OAuth client: `ShineGame Logto Dev`
- Audience: External / Testing
- Test user: configured (email intentionally omitted from repository evidence)
- Authorized redirect URI: the current Logto Google connector callback
- Provider token storage: disabled
- Google offline access: disabled
- Extra scopes: none; connector defaults to `openid profile email`
- Secret rotation: the initially displayed Google secret was never used, then disabled and deleted after the replacement secret was stored in Logto. Exactly one replacement secret remains enabled.

The replacement Google secret is not stored in this repository, documentation, terminal output, or application source.

## Neon local-test validation

- Neon project: `shinegame`
- Project ID: `purple-cloud-20898732`
- Root/default branch reserved for production: `production` (`br-wandering-cloud-afoejrc6`)
- Recreated development child branch: `local-test` (`br-wandering-firefly-af96po7a`)
- Database engine observed during validation: PostgreSQL 18
- Migrations: `202608250001_auth_accounts.sql`, `202608260001_auth_hardening.sql`, `202608270001_fix_request_account_vip_role_variable.sql`, then `202608270002_auth_migration_batches.sql`
- Production runtime-role migration: `202608280001_auth_bff_runtime_role.sql` (implemented after this historical Neon validation; not applied to the production branch or to the recorded `local-test` evidence)

The canonical SQL files live under the repository-root `database/migrations/`
directory, outside the Netlify site base. They are owner-applied to the exact
verified Neon branch in filename order; Netlify deploys must not discover or
apply them automatically.

On 2026-08-27, read-only Neon metadata first proved that the target named
exactly `local-test` was a non-default, non-root child of `production`, and
that its ID differed from the production branch ID. Only that verified child
was deleted. The replacement `local-test` was created from the verified
production parent, after which metadata was read again: the production branch
ID and default/root status were unchanged, while the child had the new ID
recorded above. Production was not selected, queried for application data, or
used for migration/callback validation.

All four migrations were then applied in the listed order only to the new
child. Read-only verification returned 11/11 expected tables present, the VIP
request function present, `PUBLIC` execute revoked, and zero rows in accounts,
emails, identities, sessions, OAuth transactions, migration records, and
migration batches before fixture creation.

The fifth migration is a production deployment gate rather than part of that
historical local-test result. Before applying it, the database owner must
provision the fixed `shinegame_auth_bff` role out of band as a dedicated
non-owner `NOINHERIT` role (the local smoke uses `NOLOGIN`; any production
login credential, if the deployment connection requires one, is managed
outside this migration) with no superuser, role-creation,
database-creation, replication, bypass-RLS, role-membership, or public-object
ownership capability. The migration never creates a role and never stores or
rotates a password. It converges schema/type usage, runtime table privileges,
read-only migration evidence access, and the two validated `SECURITY DEFINER`
function grants; direct authorization, audit/context, merge, and migration
writes remain owner-only. The fresh PostgreSQL smoke for this fifth migration
is a release verification gate and is not represented as passed by the Neon
local-test evidence above.

The guarded local fixture seeded exactly one synthetic active VIP, one primary
email, one legacy identity, one migration record, and one reconciled migration
batch. The batch scope was exactly `neon-local-test` /
`shinegame-local-test`. The raw controlled address and runtime-only HMAC and
encryption keys were supplied only to the loopback bootstrap/BFF process and
were not written to an environment file, temporary secret file, browser
storage, documentation, or terminal output. The same crypto pair was used by
the fixture and the restarted BFF. Anonymous `/api/auth/session` returned 200
with `authenticated=false` before browser login.

All four historical migrations were applied only to the `local-test` child
branch: base, hardening, role-function fix, then migration-batch readiness. A read-only
preflight and post-migration check confirmed all 11 expected auth
tables, the encrypted nonce column, scoped legacy-session uniqueness, the VIP
request function, authorization-version mutation behavior, and revoked
`PUBLIC` execution privileges. The repository
does not contain the Neon connection string or database password, and the
`production` branch was not selected for migration or callback validation.

The first real registration-profile submission exposed a PostgreSQL name
resolution collision inside `request_account_vip`: the PL/pgSQL local variable
`current_role` was parsed as PostgreSQL's built-in `CURRENT_ROLE` expression of
type `name`. The incremental fix renames the locals to `v_current_role` and
`v_current_status` without changing the authorization contract. A real
PostgreSQL smoke first reproduced the operator error, then passed on both a
fresh schema and an existing-schema upgrade. The same transaction-wrapped
replay passed on Neon `local-test` and was rolled back; production was not
selected.

The Google connector's provider-token storage remains disabled. Separately, the
ShineGame BFF requires a Logto refresh token for its server-side session. Logto's
`Always issue refresh token` compatibility switch remains disabled; the BFF uses
the OpenID Connect flow (`offline_access` plus `prompt=consent`) instead.

## Final user-visible claim process

After the normal OIDC issuer, audience, nonce, transaction, and provider-verified-email checks, the callback has one fixed order:

1. An existing user resolves by the scoped Logto `sub` and reuses its permanent `account_id`.
2. An unbound `sub` with exactly one imported active verified-email match claims that old `account_id`; the imported role, status, profile, and migration/audit history are preserved. Provider input cannot supply or override legacy authorization or profile fields.
3. An unbound `sub` with no email match can create one new `free / active` account only after the exact source/environment/site migration batch is `reconciled`.
4. A missing or incomplete import/batch returns retryable `503 MIGRATION_NOT_READY` and writes no account, identity, or session, so an unimported legacy user is never duplicated.
5. An ambiguous email, blocked/inactive account, or conflicting subject fails closed with a sanitized `409` recovery response and no account, identity, or session write.

The local BFF starts anonymous when a development database is configured and the browser has no valid first-party session cookie. It never seeds or silently signs in a default `Local Admin`; only the explicit runtime-only synthetic fixture harness writes the exact disposable local-test boundary. Static `file://` / `:8000` pages use Mock data, while `localhost:8888` performs real authentication checks.

## Callback claim contract

The local Google callback contract was proved and recorded with values redacted:

- exact issuer match;
- application audience match;
- stable `sub`;
- nonce validation;
- email claim plus provider assertion that the email is verified;
- connector target or equivalent provider discriminator;
- provider-specific subject semantics and connector scope for every connector actually enabled;
- no provider tokens in browser storage, URLs, logs, or durable evidence.

### Earlier pre-recreation Google baseline

The following free-account callback evidence predates the recreated Task 4
`local-test` branch and is retained only as an earlier credential baseline. It
does not describe the current seeded VIP claim.

The final local synthetic Google replay accepted the callback only after all
claim checks passed. Redacted diagnostics confirmed issuer, audience, subject,
verified email, nonce presence and nonce-hash equality, plus a Logto refresh
token. The BFF then created one free account, one encrypted email record, one
scoped Logto identity, and one active first-party session, all joined to the
same account. No token, authorization code, nonce, email address, or secret is
retained in this evidence.

The first credentialed Google callback reached Logto successfully and Logto's
audit log recorded a successful authorization-code exchange, but the request
omitted `prompt=consent`. Logto therefore issued only an access token and ID
token, and the BFF correctly rejected the callback because no refresh token was
present.

After adding `prompt=consent`, Logto issued access, refresh, and ID tokens. An
intermediate callback was still rejected before account persistence because its
one-time transaction returned only the nonce hash. `openid-client` requires the
original nonce while validating the ID token and rejects a token containing a
nonce when no expected value is supplied. The transaction now stores the nonce
encrypted at rest in addition to its hash, returns it only after atomic
consumption, verifies the decrypted value against the hash, and supplies it to
`openid-client`. The subsequent end-to-end callback passed against Neon
`local-test`. Post-callback evidence showed one active free account, one
verified primary email, one active scoped Logto identity, and one active
first-party session containing an encrypted refresh token. A later complete
Google sign-in reused that same account/email/identity and created only a new
first-party session. The final aggregate was 1 account, 1 active email, 1
active identity, 2 active encrypted-refresh-token sessions, and 2 consumed
OAuth transactions in the exact `neon-local-test` / `shinegame-local-test`
boundary. The rejected or abandoned attempts did not create duplicate accounts
or identities.

## Blocking scenario matrix

| Scenario | Result |
|---|---|
| Exact `local-test` boundary verification, recreation from production, and production recheck | **PASS** — old child only was deleted; new child ID differs; production ID/default status unchanged |
| Full four-file migration chain on the recreated child | **PASS** — structure/function/grant checks true; initial auth row counts zero |
| Synthetic legacy VIP fixture and exact reconciled batch | **PASS** — 1 account/email/legacy identity/migration record/batch; `vip / active` |
| Anonymous local BFF with the fixture crypto pair | **PASS** — `/api/auth/session` 200 anonymous |
| Local redirect URI registration and runtime consistency | **PASS** — exact development application accepts both loopback host forms; running BFF authorization and token exchange consistently use `localhost` |
| Google claims the synthetic legacy VIP and repeat login reuses it | **PASS** — matching claim preserved the `vip / active` account, profile, migration link, and legacy identity while adding one Logto identity/session; a fresh controlled repeat added only one active Logto session family |
| Missing exact batch blocks unmatched verified callback | **PASS** — real handler/repositories/schema in a rolled-back Neon transaction returned `503 MIGRATION_NOT_READY`; no account/email/identity/session writes |
| Reconciled batch permits unmatched verified callback | **PASS** — rolled-back Neon transaction returned 302 and exactly +1 `free / active` account, email, Logto identity, and session |
| Unverified email | **PASS** — 401 and no account/email/identity/session writes |
| Duplicate active email rows | **PASS** — controlled corruption inside a rolled-back transaction returned 409, created no rows, and restored the unique index |
| Conflicting `sub` | **PASS** — unique collision created no account/email/identity/session rows; transaction rolled back |
| Callback replay | **PASS** — 401 and no account/email/identity/session writes |
| Email OTP claims one synthetic legacy account by verified email | **PENDING** — configuration is verified, but real OTP delivery and callback have not been run |
| QQ creates a scoped identity without relying on email | DEFERRED; excluded from first rollout |
| QQ already bound to an empty duplicate is safely reauthorized or classified `needs_manual_repair` | DEFERRED; automatic transfer must not be assumed in any future rollout |
| Unknown verified email creates a free account without changing legacy VIP data | PASS in a rolled-back real Neon callback transaction; durable fixture counts remained 1 account / 1 email / 1 legacy identity / 0 sessions |

## Security decisions

- The initial application secret shown by the provider quick-start UI is not an approved implementation credential and is not stored in this repository.
- A short-lived application secret was created immediately before credentialed local integration. It was transferred only to the loopback runtime; the final cross-process handoff used a mode-`0600` one-time file under `/private/tmp`, which the helper deleted in `finally`. Exact-value scans found no copy in repository files or the staged diff.
- The 2026-08-27 recreated-branch validation did not reuse that file handoff. The existing development secret and controlled test address moved directly from browser-process memory to a loopback-only bootstrap form, which seeded the fixture and spawned Netlify Dev with one in-memory environment object. The form was abandoned immediately and the controller variables and clipboard were cleared.
- Google Cloud 2-step verification was completed by the account owner before project and credential creation.
- QQ is intentionally paused. The unfinished connector form was never saved and no QQ credential exists.
- WeChat is not an automatic substitute for QQ. Any future WeChat work requires a fresh design/validation gate and must not reuse QQ identity assumptions.
- The BFF, Google connector, and synthetic legacy VIP claim/repeat are locally integrated. The rollout is not release-ready until email OTP and fresh-profile HTTPS stage callback gates pass.

## Remaining gate

The local redirect failure was isolated to loopback host identity. Authorization
initially used `http://127.0.0.1:8888/api/auth/callback` while the development
application registered only `http://localhost:8888/api/auth/callback`. After
preserving the valid `localhost` entry and adding the exact `127.0.0.1` entry,
provider audit showed Netlify Dev normalizes the callback request to
`localhost`; using a code bound to `127.0.0.1` at a `localhost` token exchange
therefore failed. The restarted BFF now uses `localhost` consistently for its
callback, allowed origin, and site URL. No application Secret, Google connector
credential, or production configuration changed.

The first post-fix browser login silently reused a different Google/Logto
account and correctly created a free account instead of claiming the fixture.
A runtime-only keyed comparison proved the controlled fixture email still maps
only to the VIP account. The exact free account/email/identity/session graph was
removed only from `local-test`, restoring the pre-login durable aggregate.

The matching controlled-account claim then passed: one `vip / active` account,
one verified email, one legacy identity, one Logto `sub` identity, one active
Logto session family, one migration record, preserved fixture profile, and no
ambiguity or free duplicate. For the repeat, a fresh one-time transaction
forced reauthentication without logging out or deleting browser sessions. A
loopback-only HMAC comparison selected the unique signed-in Gmail candidate
already mapped to the VIP; the raw value was cleared immediately. The browser
returned to the local app with the VIP badge visible. Accounts/emails/identities
remained 1/1/2 and exactly one additional active Logto session family was
created, leaving 2 active families on the same permanent account.

A focused preservation assertion after the repeat confirmed the safe synthetic
labels `Synthetic` (guild) and `Legacy Fixture` (game name), authorization
version `1`, a present migration ID, and exactly one migration row whose ID
matches the account link. Only booleans, labels, and the numeric version were
reported; no UUID was retained.

Session counts distinguish active logins from history. Immediately after the
first successful claim there was exactly one active Logto session family. The
repeat created exactly one second active family on the same account. The final
table contained 4 rows: 2 active Logto families and 2 revoked historical rows;
there were no non-revoked expired rows. These historical rows do not represent
extra active logins, and the repeat did not duplicate the account, email, or
identity.

One separate in-app-browser attempt was made before accepting the controlled
Chrome repeat evidence. The isolated in-app-browser surface was unavailable at
browser binding time, so it could not create a tab or OAuth transaction and no provider
or database state changed. The narrow local equivalent therefore remains the
completed forced-reauth transaction, explicit Google account chooser, unique
runtime-only HMAC match to the seeded VIP, local callback completion, visible
VIP UI, and database invariants above. This is not a substitute for a
fresh-profile HTTPS stage test.

Two release gates remain explicit: configure an exact HTTPS
`AUTH_STAGE_CALLBACK_URL` ending in `/api/auth/callback` and repeat Google
acceptance in a genuinely fresh browser profile against HTTPS stage; and run
real email OTP delivery plus callback using only synthetic development users,
including one verified-email legacy claim. Update the pending matrix rows with
redacted evidence and rerun the callback contract test. Local Google
legacy-linking/repeat and the missing/incomplete-batch fail-closed matrix are
already PASS. A separate production credential rotation remains part of the
production-release gate. QQ and WeChat remain outside this rollout.

There is intentionally no `npm run test:e2e` command until a real HTTPS-stage
Playwright runtime contract and credentials-safe setup exist. The release gate
is the documented manual genuinely-fresh-profile HTTPS stage callback
acceptance above; no placeholder or nonexistent spec is reported as automated
coverage.
