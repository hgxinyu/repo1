# Logto Unified Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace email-keyed Netlify Identity authorization with Logto Google/QQ/email-OTP authentication, permanent account IDs, transactional sessions, and a reversible smooth migration that preserves every existing VIP/Admin decision.

**Architecture:** Logto proves identity through Hosted UI and OIDC; Netlify Functions act as a BFF and issue opaque HttpOnly application sessions. Netlify Database/Postgres is the sole source of truth for accounts, identity mappings, sessions, migration state, merges, and AI rate limits; legacy Netlify Identity remains a read-only bridge for a fixed 30-day migration window.

**Tech Stack:** Static HTML/ES modules, Netlify Functions, Netlify Database/Postgres, `@netlify/database`, `postgres`, `openid-client`, Node `node:test`, `@netlify/dev`, Playwright, Logto Cloud, Netlify Identity during migration only.

**Spec:** `docs/superpowers/specs/2026-08-25-logto-authentication-redesign-design.md`

## 2026-08-26 Scope Amendment

- Phase-one authentication is Google OAuth plus email OTP.
- QQ OAuth is paused and is not a Task 5, Task 6, Task 10, Task 11, Task 12, or release gate. Do not save an incomplete QQ connector or claim QQ validation.
- WeChat is a future candidate only. It requires a separate approved design and credentialed validation before any implementation; do not reuse QQ subject or merge assumptions.
- Existing QQ-specific steps below are retained as deferred reference. For the current execution, replace required QQ PASS criteria with an explicit `DEFERRED` record and validate only Google and email OTP.

## Global Constraints

- Work on `stage` or an isolated worktree created from `stage`; do not implement directly on `main`.
- Do not enable Netlify Database, consume Netlify credits, create production Logto/OAuth resources, write live data, commit, push, or deploy without explicit authorization in the current turn.
- Existing `vip-users` and Netlify Identity data are read-only until the approved freeze/import operation; stage and production data are currently shared.
- Use Logto Hosted UI. Do not build a headless OTP form in this release.
- Authentication options for phase one are Google and email OTP; QQ is deferred, Apple is out of scope, and WeChat is a future candidate requiring a separate design gate.
- `blocked` overrides `admin`, `vip`, `free`, and `pending` on every page and API.
- Registered pages are Soul Ascension, Expedition, and Awakening Gala Simulator. AIAsk is VIP-only. Admin is admin-only.
- Logto/provider tokens, passwords, and verification codes never enter browser storage, URLs, logs, or Blobs.
- Business authorization only accepts `accountId` from a server-resolved `AuthContext`; email is never an authorization fallback.
- Visible authentication text must be updated in both Chinese and English.
- Local static preview remains mock-only and never calls real auth APIs. Logto integration uses an isolated development tenant and isolated local/branch Postgres with synthetic users.
- Each commit step below is conditional: if the user has not explicitly authorized a commit in that turn, leave the reviewed changes uncommitted and report the suggested commit message.

## File Structure

Create focused shared modules instead of expanding `_shared/access.mjs`:

```text
flipgame/netlify/database/migrations/
  202608250001_auth_accounts.sql          transactional schema and constraints

flipgame/netlify/functions/_shared/auth/
  config.mjs                              environment and sentinel validation
  db.mjs                                  Postgres connection and transaction helper
  crypto.mjs                              HMAC, encryption, opaque tokens
  capabilities.mjs                        role/status to canonical capabilities
  account-repository.mjs                  accounts, emails, identities, migration claims
  session-repository.mjs                  OAuth transactions and app sessions
  auth-context.mjs                        cookie/session resolver and capability gates
  logto-client.mjs                        OIDC discovery, authorize, callback, revoke
  http.mjs                                JSON, cookies, Origin/CSRF, safe next, no-store

flipgame/netlify/functions/
  auth-sign-in.mjs                        start Hosted UI authorization
  auth-callback.mjs                       exchange code and claim/create account
  auth-session.mjs                        return canonical current session
  auth-logout.mjs                         revoke local/Logto session
  auth-legacy-bridge.mjs                  exchange valid Netlify session for bridge session
  account-identities.mjs                  list linked methods
  account-identity-link.mjs               start/finish provider linking
  account-identity-unlink.mjs             remove a non-last method
  account-merge-preview.mjs               enumerate affected records
  account-merge-confirm.mjs               start durable merge saga
  account-merge-status.mjs                expose saga status without secrets

flipgame/assets/
  account-session.js                      call `/api/auth/session`, login, logout
  vip-guard.js                            consume canonical capabilities only

flipgame/scripts/auth-migration/
  snapshot.mjs                            read-only legacy export
  transform.mjs                           pure legacy-to-account conversion
  dry-run.mjs                             counts and conflict report
  import.mjs                              frozen-mode transactional import
  reconcile.mjs                           post-import read-only verification

flipgame/test/auth/                        Node unit/integration tests
flipgame/test/e2e/auth.spec.mjs            browser acceptance tests
docs/auth-logto-development-validation.md  credentialed connector evidence
```

Existing files modified across tasks:

```text
netlify.toml
flipgame/package.json
flipgame/package-lock.json
flipgame/index.html
flipgame/Login.html
flipgame/Register.html
flipgame/Admin.html
flipgame/AwakeningRushSimulator.html
flipgame/SoulAscensionCalculator.html
flipgame/ExpeditionCalculator.html
flipgame/AIAsk.html
flipgame/assets/auth-session.js
flipgame/netlify/functions/_shared/access.mjs
flipgame/netlify/functions/me.mjs
flipgame/netlify/functions/vip-request.mjs
flipgame/netlify/functions/admin-users.mjs
flipgame/netlify/functions/admin-set-role.mjs
flipgame/netlify/functions/admin-delete-user.mjs
flipgame/netlify/functions/admin-quality-prices.mjs
flipgame/netlify/functions/admin-traffic.mjs
flipgame/netlify/functions/_shared/quality-prices.mjs
flipgame/netlify/functions/ai-chat.mjs
docs/vip-access.md
docs/ai-ask.md
docs/awakening-rush-simulator.md
README.md
```

---

### Task 1: Freeze Authorization Contracts and Establish the Test Harness

**Files:**
- Modify: `flipgame/package.json`
- Modify: `flipgame/package-lock.json`
- Create: `flipgame/test/auth/capabilities.test.mjs`
- Create: `flipgame/netlify/functions/_shared/auth/capabilities.mjs`
- Modify: `docs/vip-access.md`
- Modify: `docs/awakening-rush-simulator.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: roles `pending|free|vip|admin|blocked` from the approved spec.
- Produces: `capabilitiesForAccount(account): { authenticated, role, canAccessRegistered, canAccessPremium, isAdmin, blocked }`.

- [ ] **Step 1: Add Node test scripts and dependencies**

Add these scripts without removing the existing knowledge-index scripts:

```json
{
  "scripts": {
    "test": "node --test test/**/*.test.mjs",
    "test:auth": "node --test test/auth/*.test.mjs",
    "test:e2e": "playwright test test/e2e/auth.spec.mjs"
  },
  "dependencies": {
    "@netlify/database": "latest",
    "openid-client": "latest",
    "postgres": "latest"
  },
  "devDependencies": {
    "@netlify/dev": "latest",
    "@playwright/test": "latest"
  }
}
```

Run: `npm install`

Expected: lockfile updates; no production resource is provisioned.

- [ ] **Step 2: Write the failing capability matrix test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { capabilitiesForAccount } from "../../netlify/functions/_shared/auth/capabilities.mjs";

const cases = [
  ["pending", true, false, false],
  ["free", true, false, false],
  ["vip", true, true, false],
  ["admin", true, true, true],
  ["blocked", false, false, false]
];

test("role matrix is canonical and blocked wins", () => {
  for (const [role, registered, premium, admin] of cases) {
    const value = capabilitiesForAccount({ role, status: role === "blocked" ? "blocked" : "approved" });
    assert.equal(value.canAccessRegistered, registered);
    assert.equal(value.canAccessPremium, premium);
    assert.equal(value.isAdmin, admin);
  }
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `cd flipgame && npm run test:auth`

Expected: FAIL because `capabilities.mjs` does not exist.

- [ ] **Step 4: Implement the minimal canonical capability function**

```js
const ROLES = new Set(["pending", "free", "vip", "admin", "blocked"]);

export function normalizeRole(value) {
  const role = String(value || "").trim().toLowerCase();
  return ROLES.has(role) ? role : "pending";
}

export function capabilitiesForAccount(account) {
  const role = normalizeRole(account && account.role);
  const blocked = role === "blocked" || account?.status === "blocked";
  return {
    authenticated: true,
    role,
    blocked,
    canAccessRegistered: !blocked,
    canAccessPremium: !blocked && (role === "vip" || role === "admin"),
    isAdmin: !blocked && role === "admin"
  };
}
```

- [ ] **Step 5: Run tests and align durable access documentation**

Run: `cd flipgame && npm run test:auth && npm run check:functions`

Expected: PASS.

Update docs so Awakening is registered-member, AIAsk is VIP-only, and blocked always wins.

- [ ] **Step 6: Conditional commit checkpoint**

Suggested commit: `test: define canonical account capabilities`

---

### Task 2: Add Transactional Auth Schema and Environment Isolation

**Files:**
- Create: `flipgame/netlify/database/migrations/202608250001_auth_accounts.sql`
- Create: `flipgame/netlify/functions/_shared/auth/db.mjs`
- Create: `flipgame/netlify/functions/_shared/auth/config.mjs`
- Create: `flipgame/test/auth/config.test.mjs`
- Create: `flipgame/test/auth/schema.test.mjs`

**Interfaces:**
- Consumes: `NETLIFY_DB_URL`, `AUTH_ENV_ID`, `AUTH_EXPECTED_SITE_ID`, `LOGTO_ENDPOINT`, `LOGTO_APP_ID`.
- Produces: `sql`, `withTransaction(callback)`, `assertAuthEnvironment(env)`, and the seven schema tables from the spec.

- [ ] **Step 1: Write failing environment-sentinel tests**

```js
test("rejects a tenant/site/database mismatch", () => {
  assert.throws(() => assertAuthEnvironment({
    AUTH_ENV_ID: "stage",
    AUTH_EXPECTED_SITE_ID: "site-stage",
    NETLIFY_SITE_ID: "site-production",
    LOGTO_ENDPOINT: "https://prod.logto.app"
  }), /AUTH_ENV_MISMATCH/);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd flipgame && node --test test/auth/config.test.mjs`

Expected: FAIL because `config.mjs` does not exist.

- [ ] **Step 3: Implement strict environment parsing**

```js
export function assertAuthEnvironment(env) {
  const required = ["AUTH_ENV_ID", "AUTH_EXPECTED_SITE_ID", "NETLIFY_SITE_ID", "NETLIFY_DB_URL", "LOGTO_ENDPOINT", "LOGTO_APP_ID"];
  for (const name of required) if (!String(env[name] || "").trim()) throw new Error(`AUTH_CONFIG_MISSING:${name}`);
  if (env.AUTH_EXPECTED_SITE_ID !== env.NETLIFY_SITE_ID) throw new Error("AUTH_ENV_MISMATCH:SITE");
  if (!new URL(env.LOGTO_ENDPOINT).hostname.endsWith(".logto.app")) throw new Error("AUTH_ENV_MISMATCH:LOGTO");
  return Object.freeze({ environmentId: env.AUTH_ENV_ID, siteId: env.NETLIFY_SITE_ID });
}
```

- [ ] **Step 4: Add the SQL migration with real constraints**

Create enums/check constraints and tables for accounts, encrypted emails, scoped identities, sessions, OAuth/bridge transactions, migration records, merge operations, and hourly AI limits. The identity constraint must be:

```sql
create unique index auth_identities_scope_subject_uidx
  on auth_identities (issuer_or_tenant, connector_scope, provider_subject)
  where revoked_at is null;

create unique index account_emails_lookup_uidx
  on account_emails (email_lookup_hash)
  where removed_at is null;
```

Session rows must include `auth_source`, `session_id_hash`, `account_id`, optional `logto_subject`, optional `legacy_netlify_user_id`, `migration_id`, encrypted refresh token, idle/absolute expiry, `authz_version`, `rotation_version`, and `revoked_at`.

- [ ] **Step 5: Add database helpers**

```js
import postgres from "postgres";
export const sql = postgres(process.env.NETLIFY_DB_URL, { max: 4, idle_timeout: 20 });
export function withTransaction(callback) {
  return sql.begin(async (transaction) => callback(transaction));
}
```

- [ ] **Step 6: Verify against isolated local Postgres**

Run: `cd flipgame && npx netlify dev --offline`

In another terminal run: `npm run test:auth`

Expected: schema applies to the local database; duplicate email and duplicate scoped identity tests fail with unique-constraint errors. Do not connect to production.

- [ ] **Step 7: Conditional commit checkpoint**

Suggested commit: `feat: add transactional auth data model`

---

### Task 3: Implement Account Repository and AuthContext Resolution

**Files:**
- Create: `flipgame/netlify/functions/_shared/auth/account-repository.mjs`
- Create: `flipgame/netlify/functions/_shared/auth/auth-context.mjs`
- Create: `flipgame/test/auth/account-repository.test.mjs`
- Create: `flipgame/test/auth/auth-context.test.mjs`

**Interfaces:**
- Consumes: `sql`, `withTransaction`, `capabilitiesForAccount`.
- Produces: `createAccount`, `findAccountByLogtoSubject`, `findAccountByLegacyUserId`, `claimLegacyAccountByVerifiedEmail`, `resolveAuthContext`, `requireCapability`.

- [ ] **Step 1: Write failing repository tests**

Cover these exact invariants:

```js
test("verified email claim binds one Logto subject to one legacy account", async () => {
  const result = await claimLegacyAccountByVerifiedEmail(tx, {
    logtoSubject: "logto-user-1",
    issuerOrTenant: "tenant-dev",
    connectorScope: "email-otp",
    normalizedEmail: "vip@example.com"
  });
  assert.equal(result.accountId, legacyVipAccountId);
});

test("a collision never creates a second VIP mapping", async () => {
  await assert.rejects(() => claimLegacyAccountByVerifiedEmail(tx, collision), /ACCOUNT_CLAIM_CONFLICT/);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `cd flipgame && node --test test/auth/account-repository.test.mjs test/auth/auth-context.test.mjs`

Expected: FAIL with missing exports.

- [ ] **Step 3: Implement repository operations as transactions**

Use `SELECT ... FOR UPDATE` on the email and account rows. Accept verified email only as a claim input; return accountId and never authorize directly from email.

```js
export async function claimLegacyAccountByVerifiedEmail(tx, input) {
  const lookupHash = emailLookupHash(input.normalizedEmail);
  const [email] = await tx`select * from account_emails where email_lookup_hash=${lookupHash} and removed_at is null for update`;
  if (!email) return { kind: "new_account" };
  const existing = await tx`select * from auth_identities where account_id=${email.account_id} and issuer_or_tenant=${input.issuerOrTenant} and revoked_at is null for update`;
  if (existing.length && !existing.some((row) => row.provider_subject === input.logtoSubject)) throw new Error("ACCOUNT_CLAIM_CONFLICT");
  await tx`insert into auth_identities ${tx({ account_id: email.account_id, issuer_or_tenant: input.issuerOrTenant, connector_scope: input.connectorScope, provider_subject: input.logtoSubject, subject_type: "sub" })} on conflict do nothing`;
  return { kind: "claimed", accountId: email.account_id };
}
```

- [ ] **Step 4: Implement the discriminated AuthContext**

```js
export async function resolveAuthContext(req) {
  const session = await readValidSessionFromCookie(req);
  if (!session) return null;
  const account = session.authSource === "logto"
    ? await findAccountByLogtoSubject(session.logtoSubject)
    : await findAccountByLegacyUserId(session.legacyNetlifyUserId);
  if (!account || account.authzVersion !== session.authzVersion) throw new AuthError("SESSION_STALE", 401);
  return { authSource: session.authSource, accountId: account.accountId, sessionId: session.id, authnSubject: session.authnSubject, authzVersion: account.authzVersion, migrationId: session.migrationId || null, account, capabilities: capabilitiesForAccount(account) };
}
```

- [ ] **Step 5: Run repository and context tests**

Run: `cd flipgame && npm run test:auth`

Expected: PASS for blocked precedence, missing mapping fail-closed, and both auth sources resolving to accountId.

- [ ] **Step 6: Conditional commit checkpoint**

Suggested commit: `feat: resolve authorization through permanent accounts`

---

### Task 4: Build Cryptography, OAuth Transactions, and Opaque Sessions

**Files:**
- Create: `flipgame/netlify/functions/_shared/auth/crypto.mjs`
- Create: `flipgame/netlify/functions/_shared/auth/session-repository.mjs`
- Create: `flipgame/netlify/functions/_shared/auth/http.mjs`
- Create: `flipgame/test/auth/crypto.test.mjs`
- Create: `flipgame/test/auth/session-repository.test.mjs`
- Create: `flipgame/test/auth/http.test.mjs`

**Interfaces:**
- Produces: `randomToken`, `tokenHash`, `encryptSecret`, `decryptSecret`, `createOAuthTransaction`, `consumeOAuthTransaction`, `createAppSession`, `rotateSession`, `revokeSessionFamily`, `safeNextPath`, `assertTrustedOrigin`, `sessionCookie`, `clearSessionCookie`.

- [ ] **Step 1: Write failing security tests**

Test that `//evil.example`, encoded backslashes, absolute URLs, replayed transactions, wrong environment, expired transactions, stale refresh versions, and untrusted Origin all fail.

```js
test("safeNextPath only accepts an allowlisted same-origin relative path", () => {
  assert.equal(safeNextPath("AIAsk.html"), "/AIAsk.html");
  assert.throws(() => safeNextPath("//evil.example"), /INVALID_NEXT/);
  assert.throws(() => safeNextPath("https:%2f%2fevil.example"), /INVALID_NEXT/);
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `cd flipgame && node --test test/auth/crypto.test.mjs test/auth/session-repository.test.mjs test/auth/http.test.mjs`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement cryptography with Node Web Crypto**

Use 32 random bytes for opaque values, SHA-256 for stored token hashes, HMAC-SHA-256 for email lookup, and AES-256-GCM for refresh tokens. Require separate `AUTH_HMAC_KEY` and `AUTH_ENCRYPTION_KEY`; reject wrong key lengths.

- [ ] **Step 4: Implement transaction/session TTLs exactly**

- OAuth transaction: 10 minutes, single consumption.
- Bridge transaction: 5 minutes, single consumption.
- Logto session: idle 14 days, absolute 30 days.
- Legacy bridge session: idle 14 days, absolute no later than `migrationWindowEndsAt`; no refresh token.
- Refresh uses `SELECT ... FOR UPDATE`, increments `rotation_version`, and revokes the family on replay.

- [ ] **Step 5: Implement cookie and response headers**

```js
export function sessionCookie(value, maxAge) {
  return `__Host-shinegame_session=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

export const PRIVATE_RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "Vary": "Cookie"
};
```

- [ ] **Step 6: Run all auth tests**

Run: `cd flipgame && npm run test:auth`

Expected: PASS, including concurrent refresh and replay tests.

- [ ] **Step 7: Conditional commit checkpoint**

Suggested commit: `feat: add secure auth transactions and sessions`

---

### Task 5: Validate Logto Development Tenant Before Product Integration

**Files:**
- Create: `docs/auth-logto-development-validation.md`
- Create: `flipgame/test/auth/logto-callback-contract.test.mjs`

**Interfaces:**
- Consumes: approved development Logto tenant credentials supplied through environment variables.
- Produces: recorded connector IDs, issuer, application ID, callback URLs, verified claim samples with secrets redacted, and PASS/FAIL gates for email claim, Google linking, QQ connector, and QQ duplicate repair.

- [ ] **Step 1: Create a development-only traditional web application**

Use callback URLs:

```text
http://localhost:8888/api/auth/callback
the exact HTTPS value of AUTH_STAGE_CALLBACK_URL, whose path must be /api/auth/callback on the stage host
```

Record the resolved stage callback URL in the redacted validation evidence; abort validation if it is missing, non-HTTPS, cross-host, or has a different path.

Do not configure production domains or import real users.

- [ ] **Step 2: Configure Hosted UI and connectors**

Enable email OTP, Google, and QQ in development. Disable provider token storage and do not request `offline_access` from Google/QQ.

- [ ] **Step 3: Record redacted callback contracts**

The evidence document must record whether Logto returns `sub`, issuer, verified primary email, connector target, and QQ subject semantics. It must never contain client secrets, codes, tokens, or full callback query strings.

- [ ] **Step 4: Execute blocking scenarios**

Run synthetic tests for:

1. Email OTP creates a Logto user and callback verified email claims one legacy account.
2. Google verified email links to the same Logto user/account under the chosen automatic-linking setting.
3. QQ login creates a scoped identity without relying on email.
4. QQ identity already bound to an empty duplicate user can either be safely reauthorized to the target or is classified `needs_manual_repair`.
5. Unknown email creates a new free account without touching legacy VIP data.

- [ ] **Step 5: Gate implementation on evidence**

Run: `cd flipgame && node --test test/auth/logto-callback-contract.test.mjs`

Expected: PASS for email, Google, and QQ basic login. The duplicate QQ case may PASS as `needs_manual_repair`; it must not be recorded as an automatic transfer unless the tenant proves it.

- [ ] **Step 6: Conditional commit checkpoint**

Suggested commit: `docs: record Logto development validation`

---

### Task 6: Implement Logto BFF Login, Callback, Session, and Logout

**Files:**
- Create: `flipgame/netlify/functions/_shared/auth/logto-client.mjs`
- Create: `flipgame/netlify/functions/auth-sign-in.mjs`
- Create: `flipgame/netlify/functions/auth-callback.mjs`
- Create: `flipgame/netlify/functions/auth-session.mjs`
- Create: `flipgame/netlify/functions/auth-logout.mjs`
- Modify: `netlify.toml`
- Create: `flipgame/test/auth/auth-functions.test.mjs`

**Interfaces:**
- Consumes: Tasks 2–5 interfaces.
- Produces: `/api/auth/sign-in`, `/api/auth/callback`, `/api/auth/session`, `/api/auth/logout` and first-party session cookies.

- [ ] **Step 1: Write failing function tests**

Test method restrictions, state/nonce/PKCE, safe next, callback cancellation, verified-email legacy claim, new account creation, blocked account denial, no-store headers, trusted Origin, logout revocation, and redacted errors.

- [ ] **Step 2: Run and confirm failure**

Run: `cd flipgame && node --test test/auth/auth-functions.test.mjs`

Expected: FAIL with missing function modules.

- [ ] **Step 3: Implement `logto-client.mjs` with `openid-client`**

Expose exactly:

```ts
buildAuthorizationUrl(input: { transaction: OAuthTransaction; locale: string; connectorHint?: "google" | "qq" | "email" }): Promise<URL>
exchangeAuthorizationCode(input: { currentUrl: URL; transaction: OAuthTransaction }): Promise<{ claims: ValidatedLogtoClaims; refreshToken: string }>
revokeLogtoGrant(input: { refreshToken: string }): Promise<void>
```

Discovery must use the configured issuer and validate the returned issuer exactly.

- [ ] **Step 4: Implement callback account resolution**

Callback order:

1. consume OAuth transaction;
2. exchange code;
3. validate issuer/audience/nonce;
4. look up existing Logto subject;
5. if missing and verified email exists, call `claimLegacyAccountByVerifiedEmail`;
6. otherwise create a free account and scoped identity transactionally;
7. reject blocked accounts;
8. create app session and set cookie;
9. redirect only to `transaction.nextPath`.

- [ ] **Step 5: Add explicit Netlify routes**

Add redirects for all four endpoints and preserve existing redirects.

- [ ] **Step 6: Run tests and syntax checks**

Run: `cd flipgame && npm run test:auth && npm run check:functions`

Expected: PASS.

- [ ] **Step 7: Conditional commit checkpoint**

Suggested commit: `feat: add Logto BFF authentication endpoints`

---

### Task 7: Build Read-Only Snapshot, Freeze, Dry-Run, Import, and Reconciliation

**Files:**
- Create: `flipgame/scripts/auth-migration/snapshot.mjs`
- Create: `flipgame/scripts/auth-migration/transform.mjs`
- Create: `flipgame/scripts/auth-migration/dry-run.mjs`
- Create: `flipgame/scripts/auth-migration/import.mjs`
- Create: `flipgame/scripts/auth-migration/reconcile.mjs`
- Create: `flipgame/test/auth/migration-transform.test.mjs`
- Create: `flipgame/test/auth/migration-reconcile.test.mjs`
- Modify: `flipgame/netlify/functions/_shared/access.mjs`

**Interfaces:**
- Produces: `transformLegacySnapshot(snapshot)`, stable report JSON, idempotent import keyed by `(source, source_user_id)`, and `MIGRATION_WRITE_MODE=legacy|frozen|account` enforcement.

- [ ] **Step 1: Write pure transformation tests with fixtures**

Fixtures must cover profile-only, Identity-only, duplicate normalized email, missing immutable user ID, admin-email mismatch, blocked admin, unknown confirmation, and every role.

- [ ] **Step 2: Run and verify failure**

Run: `cd flipgame && node --test test/auth/migration-transform.test.mjs`

Expected: FAIL with missing transformer.

- [ ] **Step 3: Implement a deterministic transformer**

The report schema is fixed:

```js
{
  snapshotId,
  snapshotHash,
  sourceCounts: { profiles, identityUsers },
  roleCounts: { pending, free, vip, admin, blocked },
  importable: [],
  conflicts: [],
  warnings: []
}
```

Generate account IDs deterministically from `migrationId + immutableNetlifyUserId` for retry safety; never from email alone.

- [ ] **Step 4: Implement the write freeze**

Add `assertLegacyWriteAllowed(operation)` to old write paths. In `frozen`, `vip-request`, admin role/profile writes, `/api/me` confirmation writeback, and admin-users writeback return `503 AUTH_MIGRATION_FROZEN`. In `account`, these paths must use Postgres adapters, not Blob writes.

- [ ] **Step 5: Implement import and reconciliation guards**

`import.mjs` must refuse to run unless:

```text
MIGRATION_WRITE_MODE=frozen
AUTH_ENV_ID=production
--snapshot-id matches the file
--apply is explicitly present
```

Without `--apply`, it prints the dry-run and writes nothing. `reconcile.mjs` compares source snapshot hash, counts, role distribution, account IDs, and missing/extra rows.

- [ ] **Step 6: Test only against fixtures/local database**

Run: `cd flipgame && npm run test:auth`

Expected: PASS; no live Blob or Identity call occurs.

- [ ] **Step 7: Conditional commit checkpoint**

Suggested commit: `feat: add safe account migration tooling`

---

### Task 8: Implement the Replay-Safe Legacy Session Bridge

**Files:**
- Create: `flipgame/netlify/functions/auth-legacy-bridge.mjs`
- Create: `flipgame/test/auth/legacy-bridge.test.mjs`
- Modify: `netlify.toml`
- Modify: `flipgame/assets/auth-session.js`

**Interfaces:**
- Consumes: legacy Netlify server verification, migration records, OAuth transaction/session repositories.
- Produces: `/api/auth/legacy-bridge` and a 30-day-window-limited `legacy_bridge` AuthContext.

- [ ] **Step 1: Write failing bridge tests**

Cover valid immutable user ID, invalid/expired Netlify session, missing migration mapping, email-only fallback rejection, CSRF, wrong environment, replay, malicious next, and expiry beyond migration window.

- [ ] **Step 2: Run and confirm failure**

Run: `cd flipgame && node --test test/auth/legacy-bridge.test.mjs`

Expected: FAIL because the endpoint is missing.

- [ ] **Step 3: Implement bridge flow**

The endpoint must:

```text
trusted Origin + CSRF
→ create 5-minute transaction
→ verify old session server-side
→ immutable Netlify user ID lookup
→ consume transaction in DB transaction
→ issue legacy_bridge session
→ clear gotrue/nf cookies and return safe next
```

It never creates a Logto grant and never refreshes beyond `migrationWindowEndsAt`.

- [ ] **Step 4: Remove client-side token copying**

Change `assets/auth-session.js` so it can only detect legacy state long enough to call the bridge. It must stop copying access/refresh tokens into JavaScript-readable cookies and remove `gotrue.user`, `nf_jwt`, `nf_refresh` only after the server confirms bridge success.

- [ ] **Step 5: Run auth tests**

Run: `cd flipgame && npm run test:auth`

Expected: PASS, including replay and cross-account denial.

- [ ] **Step 6: Conditional commit checkpoint**

Suggested commit: `feat: bridge legacy sessions without user input`

---

### Task 9: Migrate Protected APIs and AI Limits to AccountId

**Files:**
- Modify: `flipgame/netlify/functions/me.mjs`
- Modify: `flipgame/netlify/functions/vip-request.mjs`
- Modify: `flipgame/netlify/functions/admin-users.mjs`
- Modify: `flipgame/netlify/functions/admin-set-role.mjs`
- Modify: `flipgame/netlify/functions/admin-delete-user.mjs`
- Modify: `flipgame/netlify/functions/admin-quality-prices.mjs`
- Modify: `flipgame/netlify/functions/admin-traffic.mjs`
- Modify: `flipgame/netlify/functions/_shared/quality-prices.mjs`
- Modify: `flipgame/netlify/functions/ai-chat.mjs`
- Create: `flipgame/test/auth/protected-api-auth.test.mjs`
- Create: `flipgame/test/auth/ai-rate-limit.test.mjs`

**Interfaces:**
- Consumes: `resolveAuthContext`, `requireCapability`, repositories.
- Produces: canonical `/api/me` and accountId-only protected mutations.

- [ ] **Step 1: Write failing behavior tests**

Assert:

- missing mapping never returns fallback free/admin;
- blocked admin is denied everywhere;
- VIP request ignores client email/role/emailVerified and uses session accountId;
- admin mutations target accountId, show affected account, and increment `authzVersion`;
- `updatedBy` stores admin accountId;
- AI limit uses atomic `(accountId, hour)` upsert and old email buckets are ignored.

- [ ] **Step 2: Run and verify failures against current code**

Run: `cd flipgame && node --test test/auth/protected-api-auth.test.mjs test/auth/ai-rate-limit.test.mjs`

Expected: FAIL because current code authorizes by email and `ADMIN_EMAILS`.

- [ ] **Step 3: Replace email authorization with AuthContext**

`GET /api/me` response contract:

```js
{
  authenticated: true,
  accountId,
  role,
  canAccessRegistered,
  canAccessPremium,
  isAdmin,
  profile: { primaryEmailMasked, guild, gameName, status }
}
```

Do not expose full email unless the signed-in account requests its own account settings.

- [ ] **Step 4: Make admin and AI mutations transactional**

Every role or blocked-status mutation increments `accounts.authz_version` and writes an audit row. Setting `status=blocked` or removing the Admin role also revokes every active session for that account; all other stale sessions fail on their next request because their stored `authzVersion` no longer matches. AI count uses:

```sql
insert into ai_hourly_limits(account_id, hour_start, count)
values ($1, date_trunc('hour', now()), 1)
on conflict (account_id, hour_start)
do update set count = ai_hourly_limits.count + 1
returning count;
```

- [ ] **Step 5: Run tests and function syntax checks**

Run: `cd flipgame && npm run test:auth && npm run check:functions`

Expected: PASS.

- [ ] **Step 6: Conditional commit checkpoint**

Suggested commit: `refactor: authorize APIs through account IDs`

---

### Task 10: Replace Frontend Login and Page Guards

**Files:**
- Create: `flipgame/assets/account-session.js`
- Modify: `flipgame/Login.html`
- Modify: `flipgame/Register.html`
- Modify: `flipgame/index.html`
- Modify: `flipgame/assets/vip-guard.js`
- Modify: `flipgame/Admin.html`
- Modify: `flipgame/AwakeningRushSimulator.html`
- Modify: `flipgame/SoulAscensionCalculator.html`
- Modify: `flipgame/ExpeditionCalculator.html`
- Modify: `flipgame/AIAsk.html`
- Create: `flipgame/test/auth/frontend-contract.test.mjs`

**Interfaces:**
- Consumes: `/api/auth/*` and canonical `/api/me`.
- Produces: one shared browser session client and capability-driven guards.

- [ ] **Step 1: Write failing source/behavior contract tests**

Check that protected pages import `account-session.js` or `vip-guard.js`, no page imports `@netlify/identity`, no client redirects to unchecked `next`, and all zh/en auth strings exist.

- [ ] **Step 2: Run and verify failure**

Run: `cd flipgame && node --test test/auth/frontend-contract.test.mjs`

Expected: FAIL on current Netlify Identity imports and raw next redirect.

- [ ] **Step 3: Implement shared browser API**

```js
export async function getAccountSession() {
  const response = await fetch("/api/auth/session", { credentials: "include", headers: { Accept: "application/json" } });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("AUTH_SESSION_UNAVAILABLE");
  return response.json();
}

export function startLogin({ next, connector, locale }) {
  const query = new URLSearchParams({ next, ...(connector && { connector }), ...(locale && { locale }) });
  window.location.assign(`/api/auth/sign-in?${query}`);
}
```

- [ ] **Step 4: Convert Login/Register to compatibility entry pages**

Both old URLs render bilingual explanation and immediately/directly offer QQ, Google, and email through `/api/auth/sign-in`. Remove password, recovery token, email confirmation, and arbitrary `window.location.href = next` logic.

- [ ] **Step 5: Convert all gates to canonical capabilities**

- registered: `canAccessRegistered`;
- VIP: `canAccessPremium`;
- Admin: `isAdmin`;
- blocked always renders denial;
- local static preview keeps the documented mock bypass without calling real APIs.

- [ ] **Step 6: Run auth, syntax, and static-server smoke tests**

Run: `cd flipgame && npm run test:auth && npm run check:functions`

Run local preview: `python3 -m http.server 8000`

Expected: homepage and protected-page mock states render; no browser console error from missing Identity imports.

- [ ] **Step 7: Conditional commit checkpoint**

Suggested commit: `feat: replace legacy login and page guards`

---

### Task 11: Add Account Center and Recoverable Merge Saga

**Files:**
- Create: `flipgame/Account.html`
- Create: `flipgame/netlify/functions/account-identities.mjs`
- Create: `flipgame/netlify/functions/account-identity-link.mjs`
- Create: `flipgame/netlify/functions/account-identity-unlink.mjs`
- Create: `flipgame/netlify/functions/account-merge-preview.mjs`
- Create: `flipgame/netlify/functions/account-merge-confirm.mjs`
- Create: `flipgame/netlify/functions/account-merge-status.mjs`
- Modify: `netlify.toml`
- Modify: `flipgame/index.html`
- Create: `flipgame/test/auth/account-merge.test.mjs`

**Interfaces:**
- Consumes: Account API/provider linking verified in Task 5, account/session repositories.
- Produces: identity list/link/unlink and durable merge state machine.

- [ ] **Step 1: Write failing merge-saga tests**

Test every state transition and inject failure after each of `verified`, `locked`, `linking`, `account_committed`, and `duplicate_disabled`. Assert retries are idempotent, source is frozen while merging, and two accounts never share active VIP access.

- [ ] **Step 2: Run and verify failure**

Run: `cd flipgame && node --test test/auth/account-merge.test.mjs`

Expected: FAIL with missing endpoints/state machine.

- [ ] **Step 3: Implement identity management invariants**

- cannot unlink the last usable sign-in/recovery method;
- every write needs current-session verification and CSRF;
- provider identity scope uses issuer/tenant + connector/client + subject;
- provider token storage stays disabled.

- [ ] **Step 4: Implement merge preview and explicit confirmation**

Preview response contains only the signed-in user's affected records:

```js
{
  source: { accountId, role, hasBusinessData },
  target: { accountId, role, hasBusinessData },
  preserved: ["vipRole", "guild", "gameName"],
  added: ["qqIdentity"],
  disabled: ["emptyDuplicateAccount"],
  confirmationToken
}
```

- [ ] **Step 5: Implement durable saga and manual repair**

If QQ cannot be safely transferred, set `needs_manual_repair`, freeze only the empty duplicate's business access, keep the original VIP reachable by email/Google, and show reauthorization instructions. Never impersonate or force-link a generic OAuth identity.

- [ ] **Step 6: Implement bilingual Account page**

Show linked methods, add/remove controls, recovery method, active sessions, merge preview, status, and exact affected objects before confirmation.

- [ ] **Step 7: Run all tests**

Run: `cd flipgame && npm test && npm run check:functions`

Expected: PASS.

- [ ] **Step 8: Conditional commit checkpoint**

Suggested commit: `feat: add account identity management and safe merging`

---

### Task 12: End-to-End Acceptance, Security Cleanup, and Documentation

**Files:**
- Create: `flipgame/playwright.config.mjs`
- Create: `flipgame/test/e2e/auth.spec.mjs`
- Modify: `docs/vip-access.md`
- Modify: `docs/ai-ask.md`
- Modify: `docs/awakening-rush-simulator.md`
- Modify: `README.md`
- Modify: `netlify.toml`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: release evidence and a codebase ready for dry-run review, not automatic production cutover.

- [ ] **Step 1: Add Playwright scenarios**

Cover desktop and mobile, zh/en, QQ, Google, email OTP, return-to-page, legacy bridge, logout, expiry, pending/free/vip/admin/blocked, account binding, merge confirmation, local Mock, and provider failure fallback. Use synthetic development users only.

- [ ] **Step 2: Add explicit security regression scenarios**

Reject open redirect, callback replay, bridge replay, CSRF, wrong Origin, wrong tenant/site/database sentinel, stale authzVersion, blocked existing session, concurrent refresh replay, and OTP abuse responses.

- [ ] **Step 3: Run complete automated verification**

Run:

```bash
cd flipgame
npm test
npm run check:functions
npm run check:knowledge-index
npm run test:e2e
```

Expected: all PASS.

- [ ] **Step 4: Search for forbidden legacy authorization paths**

Run:

```bash
rg -n "@netlify/identity|gotrue\.user|nf_jwt|nf_refresh|isAdminEmail|ADMIN_EMAILS|users/\$\{.*email|readProfile\(email" flipgame
```

Expected during dual mode: matches exist only inside explicitly named legacy bridge/migration adapters and tests. No match participates in Logto authorization or new business writes.

- [ ] **Step 5: Verify documentation and release notes requirement**

Update `docs/vip-access.md` with accountId, Logto, bridge, roles, account center, session, local Mock, and deployment prerequisites. Align README and feature docs. Because this is a major user-visible authentication/permission change, add the repository's required release-note entry if `release-notes.json` exists at implementation time.

- [ ] **Step 6: Produce an evidence summary**

Record exact test commands, results, development tenant connector validation, environment sentinel IDs with secrets redacted, known manual QQ repair behavior, dirty-worktree boundary, and remaining production-only gates.

- [ ] **Step 7: Conditional commit checkpoint**

Suggested commit: `test: verify Logto migration and account security`

---

### Task 13: Production Dry-Run, Migration, and Cutover (Separate Explicit Authorization Required)

**Files:**
- No code changes expected unless dry-run finds a reviewed defect.
- Generated evidence must stay outside git if it contains user data.

**Interfaces:**
- Consumes: reviewed implementation, production credentials, approved database provisioning, snapshot scripts, migration controls.
- Produces: production account rows, dual-mode rollout, monitored 30-day migration, and eventual Logto-only cutover.

- [ ] **Step 1: Obtain explicit current-turn authorization**

Authorization must separately cover Netlify Database credit consumption, production Logto/Google/QQ configuration, reading/exporting live Identity/profile data, applying the migration, and deployment. Commit/push/deploy permission is not inherited from earlier turns.

- [ ] **Step 2: Provision isolated production resources and validate sentinels**

Confirm production site ID, database sentinel, Logto tenant/app, callback domain, session/HMAC/encryption keys, and migration/runtime M2M separation. A mismatch must abort before any write.

- [ ] **Step 3: Run read-only dry-run and review conflicts**

Run without `--apply`. Present account totals, role totals, profile-only, Identity-only, duplicate email, missing immutable ID, blocked admin, and unresolved VIP/Admin conflicts. Do not continue until the user explicitly approves the report.

- [ ] **Step 4: Freeze legacy writes and capture the final snapshot**

Set `MIGRATION_WRITE_MODE=frozen`, record `freezeAt`, snapshot ID/hash, and verify every legacy write endpoint returns maintenance while reads continue.

- [ ] **Step 5: Apply import and reconciliation**

Run `node scripts/auth-migration/import.mjs --snapshot-file /private/tmp/shinegame-auth-migration-reviewed.json --apply`, then `node scripts/auth-migration/reconcile.mjs --snapshot-file /private/tmp/shinegame-auth-migration-reviewed.json`. Expected: the file hash matches the reviewed dry-run evidence, account/role counts agree exactly, and there are zero unresolved VIP/Admin identity collisions.

- [ ] **Step 6: Enable account writes and dual auth**

Set `MIGRATION_WRITE_MODE=account` and `AUTH_MODE=dual`. Verify synthetic Google, QQ, OTP, legacy bridge, VIP, Admin, blocked, AI rate limit, and logout flows before announcing availability.

- [ ] **Step 7: Monitor the fixed 30-day window**

Track login success per provider, legacy bridge share, mail failures, mapping conflicts, merge/manual-repair counts, denied VIP/Admin requests, and session errors without logging secrets or unnecessary PII.

Keep the encrypted pre-cutover snapshot for exactly 90 days with access logging and a named deletion date. At the end of the retention period, deletion is a separate destructive action that requires explicit approval.

- [ ] **Step 8: Gate Logto-only cutover**

Require 30 elapsed days, legacy bridge under 1% of successful logins for 7 consecutive days, zero unresolved VIP/Admin collisions, matching counts, and a successful rollback drill. Only then switch `AUTH_MODE=logto` and remove the remaining legacy authorization code in a separately reviewed change.
