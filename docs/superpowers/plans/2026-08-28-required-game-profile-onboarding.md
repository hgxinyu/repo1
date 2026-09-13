# Required Game Profile Onboarding Implementation Plan

> 状态：历史设计／实施计划，不是当前上线行为。2026-09-12 核对：当前 main 的 `Register.html` 仍通过 `/api/vip-request` 同时保存资料和转为 pending，未包含独立 `/api/account/profile` 入口或强制补资料流程。本文件后续步骤、分支和审批安排仅属当时任务；复用前按当前目标重新判断。当前事实见 [VIP 账号与权限](../../vip-access.md)。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require every non-admin authenticated account to save a game account/name and guild before using member or VIP features, without changing VIP authorization as a side effect.

**Architecture:** Add one shared server-side profile-completeness rule, a narrowly scoped authenticated profile update endpoint, and centralized enforcement in callback/runtime/frontend guards. Reuse the existing nullable `accounts.guild` and `accounts.game_name` columns, preserve verified-email legacy claims, and keep VIP requests as a separate authorization transition.

**Tech Stack:** Static HTML/ES modules, Netlify Functions, Node.js test runner, postgres.js, PostgreSQL/Neon, Logto OIDC.

**Spec:** `docs/superpowers/specs/2026-08-28-required-game-profile-onboarding-design.md`

## Global Constraints

- Implement from current `origin/main` (`f6008cb` at plan creation), because the root checkout's local `main` is ten commits behind.
- At execution start, use `superpowers:using-git-worktrees` and create an isolated `codex/required-game-profile-onboarding` worktree from `origin/main`; do not modify or delete the user's untracked `docs/superpowers/` or `flipgame/node_modules/` in the root checkout.
- A fresh account remains `active/free`; profile save never changes `role`, `status`, `authz_version`, identities, migration ownership, or sessions.
- A verified Logto email may still claim the matching migrated account and retain its existing role and permanent `account_id`.
- Active admins are profile-complete by exemption; blocked, disabled, and merged accounts remain unusable.
- Both fields are trimmed, required, 1-100 Unicode characters, and reject control characters. Users without a guild enter `无公会` or `No guild` explicitly.
- Only finite allowlisted local paths may be carried through `next` or `return_to`.
- Update Chinese and English copy together and update `docs/vip-access.md`.
- Do not access production PII or output secrets. Use synthetic fixtures and the Neon development branch for database verification.
- Do not commit, push, deploy, or change production configuration without an explicit user request in that turn. The task checkpoints below prepare reviewable diffs but do not authorize those actions.

---

### Task 1: Canonical profile rule and repository update boundary

**Files:**
- Create: `flipgame/netlify/functions/_shared/auth/account-profile.mjs`
- Modify: `flipgame/netlify/functions/_shared/auth/account-repository.mjs`
- Test: `flipgame/test/auth/account-profile.test.mjs`
- Test: `flipgame/test/auth/account-repository.test.mjs`

**Interfaces:**
- Produces: `profileCompleteForAccount(account): boolean`
- Produces: `normalizeAccountProfile(input): { guild: string, gameName: string }`, throwing `AuthError("ACCOUNT_PROFILE_INVALID", 400)` for invalid input.
- Produces: `accountRepository.updateProfile({ accountId, guild, gameName }): Promise<Account>`.
- Consumes: existing `AuthError`, `withTransaction`, account row mapper, and the BFF role's existing column-level update privileges.

- [ ] **Step 1: Write failing unit tests for completeness and validation**

```js
test("profile completeness exempts active admins only", () => {
  assert.equal(profileCompleteForAccount({ role: "admin", status: "active" }), true);
  assert.equal(profileCompleteForAccount({ role: "vip", status: "active", guild: "", gameName: "Hero" }), false);
  assert.equal(profileCompleteForAccount({ role: "free", status: "active", guild: "Guild", gameName: "Hero" }), true);
  assert.equal(profileCompleteForAccount({ role: "admin", status: "blocked" }), false);
});

test("profile validation trims and rejects unsafe values", () => {
  assert.deepEqual(normalizeAccountProfile({ guild: " Guild ", gameName: " Hero " }), {
    guild: "Guild",
    gameName: "Hero"
  });
  assert.throws(() => normalizeAccountProfile({ guild: "", gameName: "Hero" }), /ACCOUNT_PROFILE_INVALID/);
  assert.throws(() => normalizeAccountProfile({ guild: "Guild", gameName: "x\u0000y" }), /ACCOUNT_PROFILE_INVALID/);
  assert.throws(() => normalizeAccountProfile({ guild: "x".repeat(101), gameName: "Hero" }), /ACCOUNT_PROFILE_INVALID/);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `cd flipgame && node --test test/auth/account-profile.test.mjs`

Expected: FAIL because `account-profile.mjs` and its exports do not exist.

- [ ] **Step 3: Implement the shared rule and validator**

```js
import { AuthError } from "./auth-context.mjs";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

function requiredField(value) {
  if (typeof value !== "string") throw new AuthError("ACCOUNT_PROFILE_INVALID", 400);
  const normalized = value.trim();
  if (!normalized || [...normalized].length > 100 || CONTROL_CHARACTERS.test(normalized)) {
    throw new AuthError("ACCOUNT_PROFILE_INVALID", 400);
  }
  return normalized;
}

export function normalizeAccountProfile(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some((key) => !["guild", "gameName"].includes(key))) {
    throw new AuthError("ACCOUNT_PROFILE_INVALID", 400);
  }
  return { guild: requiredField(input.guild), gameName: requiredField(input.gameName) };
}

export function profileCompleteForAccount(account) {
  const role = String(account?.role || "").trim().toLowerCase();
  const status = String(account?.status || "").trim().toLowerCase();
  if (status !== "active") return false;
  if (role === "admin") return true;
  return Boolean(String(account?.guild || "").trim() && String(account?.gameName || "").trim());
}
```

- [ ] **Step 4: Write the failing repository test**

Use the existing fake tagged-SQL transaction adapter and assert that `updateProfile`:

```js
const updated = await repository.updateProfile({
  accountId: ACCOUNT_ID,
  guild: " Guild ",
  gameName: " Hero "
});
assert.equal(updated.guild, "Guild");
assert.equal(updated.gameName, "Hero");
assert.equal(updated.role, "free");
assert.equal(updated.status, "active");
assert.equal(updated.authzVersion, 7);
assert.match(seenSql, /SET guild = .*game_name = .*updated_at = now\(\)/s);
assert.doesNotMatch(seenSql, /SET role|SET status|authz_version\s*=/s);
```

- [ ] **Step 5: Implement `updateProfile` as an atomic, account-scoped repository method**

Validate `accountId` with the existing UUID helper, normalize the two fields, update only an `active` row, return the canonical account columns, and throw `ACCOUNT_NOT_FOUND` when exactly one row is not returned. Do not reuse `requestVipInTransaction`.

- [ ] **Step 6: Run focused repository tests and verify GREEN**

Run: `cd flipgame && node --test test/auth/account-profile.test.mjs test/auth/account-repository.test.mjs`

Expected: PASS with no role/status/authz mutation in profile-update assertions.

- [ ] **Step 7: Record the review checkpoint**

Review only the four Task 1 files and record test output. Do not commit without current-turn authorization.

---

### Task 2: Authenticated profile API and canonical `/api/me` state

**Files:**
- Create: `flipgame/netlify/functions/account-profile.mjs`
- Modify: `flipgame/netlify/functions/me.mjs`
- Modify: `flipgame/netlify/functions/_shared/auth/runtime.mjs`
- Test: `flipgame/test/auth/auth-functions.test.mjs`
- Test: `flipgame/test/auth/protected-api-auth.test.mjs`

**Interfaces:**
- Consumes: `profileCompleteForAccount(account)` and `accountRepository.updateProfile(input)` from Task 1.
- Produces: `POST /api/account/profile` returning `{ ok: true, profile, profileComplete: true }`.
- Produces: `/api/me.profileComplete: boolean`; browser normalization is implemented in Task 4.
- Produces: `requireRequestCapability(runtime, request, capability, { allowIncompleteProfile?: boolean })`.

- [ ] **Step 1: Write failing API contract tests**

Add handler tests that assert:

```js
const response = await handler(requestWithCsrf({ guild: "Guild", gameName: "Hero" }));
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), {
  ok: true,
  profile: { guild: "Guild", gameName: "Hero", status: "active", primaryEmailMasked: "" },
  profileComplete: true
});
assert.deepEqual(updateInput, { accountId: ACCOUNT_ID, guild: "Guild", gameName: "Hero" });
```

Also assert anonymous `401`, bad origin/missing CSRF `403`, invalid JSON/unknown fields/blank/oversized/control characters `400`, blocked account denial, and repository failure sanitized as `503`.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cd flipgame && node --test test/auth/auth-functions.test.mjs test/auth/protected-api-auth.test.mjs`

Expected: FAIL because the profile handler and `profileComplete` contract do not exist.

- [ ] **Step 3: Implement the profile endpoint**

Use `assertBrowserWriteRequest`, then call:

```js
const { context } = await requireRequestCapability(
  runtime,
  request,
  "canAccessRegistered",
  { allowIncompleteProfile: true }
);
const body = await request.json();
const account = await runtime.accountRepository.updateProfile({
  accountId: context.accountId,
  guild: body.guild,
  gameName: body.gameName
});
```

Return only canonical non-sensitive profile fields. Export Netlify config path `/api/account/profile`.

- [ ] **Step 4: Add centralized incomplete-profile enforcement**

Extend `requireRequestCapability` so member/VIP capability checks reject incomplete non-admin accounts with `AuthError("PROFILE_INCOMPLETE", 403)` unless `{ allowIncompleteProfile: true }` is explicitly passed. Extend `authErrorResponse`'s safe-code allowlist to include `PROFILE_INCOMPLETE`.

Do not enforce this option on anonymous/public handlers, and do not block admins because `profileCompleteForAccount` treats active admins as complete.

- [ ] **Step 5: Add canonical profile state to `/api/me` and browser normalization**

Return:

```js
{
  authenticated: true,
  accountId,
  role,
  canAccessRegistered,
  canAccessPremium,
  isAdmin,
  profileComplete: profileCompleteForAccount(context.account),
  profile: canonicalProfile(context.account, primaryEmailMasked)
}
```

Update `flipgame/assets/auth-session.js` normalization tests in Task 4; do not yet change navigation behavior in this task.

- [ ] **Step 6: Run API tests and verify GREEN**

Run: `cd flipgame && node --test test/auth/auth-functions.test.mjs test/auth/protected-api-auth.test.mjs`

Expected: PASS, including profile-save role invariants and `PROFILE_INCOMPLETE` fail-closed behavior.

- [ ] **Step 7: Record the review checkpoint**

Review the new endpoint's origin/CSRF/authentication boundary and safe error mapping. Do not commit without current-turn authorization.

---

### Task 3: Callback onboarding redirect without changing migration semantics

**Files:**
- Modify: `flipgame/netlify/functions/auth-callback.mjs`
- Test: `flipgame/test/auth/auth-functions.test.mjs`
- Test: `flipgame/test/auth/legacy-bridge.test.mjs`

**Interfaces:**
- Consumes: `profileCompleteForAccount(account)` from Task 1 and existing `safeNextPath`.
- Produces: `onboardingPath(nextPath): /Register.html or /Register.html?return_to=<allowlisted-basename>`.

- [ ] **Step 1: Write failing callback redirect tests**

Cover four cases:

```js
assert.equal(freshFreeResponse.status, 302);
assert.equal(freshFreeResponse.headers.get("location"), "/Register.html?return_to=AIAsk.html");
assert.equal(completeFreeResponse.headers.get("location"), "/AIAsk.html");
assert.equal(incompleteAdminResponse.headers.get("location"), "/Admin.html");
assert.equal(migratedVipResponse.headers.get("location"), "/AIAsk.html");
```

For an incomplete migrated non-admin account, assert same `accountId`, unchanged VIP/free role, no second account/identity, and onboarding redirect. Add an external/malformed next assertion that falls back to `/index.html` before constructing `return_to`.

- [ ] **Step 2: Run callback tests and verify RED**

Run: `cd flipgame && node --test test/auth/auth-functions.test.mjs test/auth/legacy-bridge.test.mjs`

Expected: FAIL because callback currently redirects every successful account directly to the original next path.

- [ ] **Step 3: Implement the redirect decision after session creation**

Keep account resolution, verified-email claim, session issuance, CSRF cookie, and preauth clearing unchanged. Replace only the final destination selection:

```js
const validatedNext = nextPath(consumed?.nextPath || transaction.nextPath || "/", {
  allowedPaths: overrides.allowedPaths
});
const destination = profileCompleteForAccount(account)
  ? validatedNext
  : onboardingPath(validatedNext);
return authRedirect(destination, 302, { "Set-Cookie": cookies });
```

The helper must map `/index.html` to `/Register.html` without a redundant return parameter and encode only a basename from the finite server allowlist.

- [ ] **Step 4: Run callback and migration tests and verify GREEN**

Run: `cd flipgame && node --test test/auth/auth-functions.test.mjs test/auth/legacy-bridge.test.mjs test/auth/account-repository.test.mjs`

Expected: PASS; existing smooth claim/replay/nonce/PKCE tests remain unchanged.

- [ ] **Step 5: Record the review checkpoint**

Review redirect safety, cookie preservation, and legacy identity invariants. Do not commit without current-turn authorization.

---

### Task 4: Browser onboarding, guards, and clear badge semantics

**Files:**
- Modify: `flipgame/assets/auth-session.js`
- Modify: `flipgame/assets/vip-guard.js`
- Modify: `flipgame/Register.html`
- Modify: `flipgame/index.html`
- Test: `flipgame/test/auth/frontend-auth.test.mjs`
- Test: `flipgame/test/auth/auth-session.test.mjs`

**Interfaces:**
- Consumes: `/api/me.profileComplete` and `POST /api/account/profile` from Task 2.
- Produces: normalized `auth.profileComplete: boolean`.
- Produces: `profileOnboardingPath(next): string` using the same finite redirect allowlist.
- Produces: registration/onboarding UI that saves profile without invoking `/api/vip-request`.

- [ ] **Step 1: Write failing browser-contract tests**

Assert the shared client rejects malformed authenticated responses that omit `profileComplete`, preserves a valid boolean, and builds only allowlisted onboarding destinations.

Add source/DOM behavior assertions that:

```js
assert.match(registerSource, /authFetch\("\/api\/account\/profile"/);
assert.doesNotMatch(registerSource, /authFetch\("\/api\/vip-request"/);
assert.match(registerSource, /保存账号资料/);
assert.match(registerSource, /Save account profile/);
```

Add guard tests for incomplete free/VIP redirect, complete registered/premium access, admin exemption, and no redirect loop on `/Register.html`.

- [ ] **Step 2: Run frontend tests and verify RED**

Run: `cd flipgame && node --test test/auth/frontend-auth.test.mjs test/auth/auth-session.test.mjs`

Expected: FAIL because the browser contract and onboarding navigation are absent.

- [ ] **Step 3: Normalize `profileComplete` and add the safe onboarding helper**

Require `typeof data.profileComplete === "boolean"` for `/api/me` authenticated state and include it in the normalized result. Implement:

```js
export function profileOnboardingPath(next = "/index.html") {
  const safe = safeAuthRedirectPath(next);
  return safe === "/Register.html" || safe === "/index.html"
    ? "/Register.html"
    : `/Register.html?return_to=${encodeURIComponent(safe.slice(1))}`;
}
```

- [ ] **Step 4: Convert `Register.html` into independent profile onboarding**

Keep unauthenticated Google/email entries. For authenticated users, prefill current values, submit to `/api/account/profile`, localize validation/status copy, and navigate to the safe destination only after a successful response with `profileComplete: true`.

Remove all “submit VIP review” copy and automatic `/api/vip-request` calls. Explain that users without a guild may enter `无公会` / `No guild`.

- [ ] **Step 5: Enforce incomplete-profile navigation in shared guards and homepage bootstrap**

Before member/VIP capability checks, redirect authenticated non-admin users with `profileComplete === false` to `profileOnboardingPath(currentPath)`. Do not redirect anonymous users or static `:8000` mock preview. Do not redirect when already on `Register.html`.

On the homepage, keep the account-level badge hidden for free/pending accounts and add an accessible tooltip/label that makes static card badges describe feature access rather than the signed-in account.

- [ ] **Step 6: Run frontend tests and verify GREEN**

Run: `cd flipgame && node --test test/auth/frontend-auth.test.mjs test/auth/auth-session.test.mjs`

Expected: PASS in Chinese/English copy and all redirect/badge assertions.

- [ ] **Step 7: Record the review checkpoint**

Review browser redirect loops, static mock behavior, safe return paths, and role badge semantics. Do not commit without current-turn authorization.

---

### Task 5: Decouple explicit VIP requests from profile persistence

**Files:**
- Modify: `flipgame/netlify/functions/vip-request.mjs`
- Modify: `flipgame/netlify/functions/_shared/auth/account-repository.mjs`
- Modify: `flipgame/Admin.html` only if its current UI sends profile fields for role review
- Test: `flipgame/test/auth/auth-functions.test.mjs`
- Test: `flipgame/test/auth/account-repository.test.mjs`
- Test: `flipgame/test/auth/protected-api-auth.test.mjs`

**Interfaces:**
- Consumes: `profileCompleteForAccount(account)` and existing controlled `request_account_vip` database function.
- Produces: `accountRepository.requestVip({ accountId }): Promise<Account>` that never writes profile fields.
- Produces: `POST /api/vip-request` accepting an empty JSON object and rejecting incomplete profiles.

- [ ] **Step 1: Write failing decoupling tests**

Assert that a completed free account becomes pending, while an incomplete free account gets `PROFILE_INCOMPLETE`; the SQL trace must contain the controlled authorization function but no `SET guild` or `SET game_name`.

Assert that the HTTP handler ignores/rejects supplied `guild`, `gameName`, `role`, `status`, or `accountId` rather than treating them as mutable request data.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cd flipgame && node --test test/auth/auth-functions.test.mjs test/auth/account-repository.test.mjs test/auth/protected-api-auth.test.mjs`

Expected: FAIL because the existing handler requires and persists `guild` and `gameName`.

- [ ] **Step 3: Refactor the repository request boundary**

Within one transaction, lock/read the current account, require canonical profile completeness, then call `public.request_account_vip(account_id, metadata)`. Return the updated account. Do not call `UPDATE accounts SET guild...` in this method.

- [ ] **Step 4: Refactor the HTTP handler**

Require same-origin CSRF and `canAccessRegistered`, parse only `{}`, call `requestVip({ accountId: context.accountId })`, and return the canonical account/profile state. Use `PROFILE_INCOMPLETE` for missing saved data and preserve idempotency for pending/VIP/admin accounts.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `cd flipgame && node --test test/auth/auth-functions.test.mjs test/auth/account-repository.test.mjs test/auth/protected-api-auth.test.mjs`

Expected: PASS with no profile mutation during VIP request.

- [ ] **Step 6: Record the review checkpoint**

Review authorization transitions and ensure profile save and VIP request are independently callable and independently auditable. Do not commit without current-turn authorization.

---

### Task 6: Documentation, full verification, and release-ready evidence

**Files:**
- Modify: `docs/vip-access.md`
- Modify: `docs/auth-logto-development-validation.md`
- Modify: `docs/history/progress.md` only if this repository uses it for durable release evidence
- Test: all auth and function checks under `flipgame/test/`

**Interfaces:**
- Consumes: all prior task outputs.
- Produces: documented product behavior and redacted validation evidence suitable for later production approval.

- [ ] **Step 1: Update durable documentation**

Document:

- fresh accounts remain free;
- migrated verified-email claims retain prior role;
- profile completion is mandatory for non-admin authenticated accounts;
- admin exemption;
- `POST /api/account/profile` and its non-authorization behavior;
- explicit VIP request as a separate `free -> pending` action;
- local/static preview and Neon development verification boundaries.

- [ ] **Step 2: Run static and full automated verification**

Run:

```bash
cd flipgame
npm test
npm run check:functions
node --check assets/auth-session.js
node --check assets/vip-guard.js
```

Expected: all tests PASS, function syntax PASS, and both browser modules parse.

- [ ] **Step 3: Run PostgreSQL verification against a disposable/development database**

Run the existing repository and schema smoke commands documented by the auth suite using an explicit development connection injected in memory. Verify account/profile writes through the least-privilege BFF role, not the owner role. Output only server version, database/branch identity, booleans, counts, roles, and statuses; never output connection URLs, raw email, subjects, ciphertext, tokens, or secrets.

Expected: schema smoke PASS; profile update changes exactly two profile fields plus `updated_at`; VIP request changes only the authorization transition and audit row.

- [ ] **Step 4: Run local browser acceptance**

Using Netlify local runtime and the Neon development branch, verify:

1. Fresh Google registration redirects to onboarding and remains free.
2. Fresh email-code registration redirects to onboarding and remains free.
3. Closing onboarding and revisiting a member page redirects back.
4. Saving valid data returns to the original allowlisted page.
5. Existing migrated VIP with complete data retains VIP without a second account.
6. Existing incomplete non-admin is prompted; active admin is exempt.
7. Logout and Admin account listing still work.

Record only redacted booleans/counts and visible role/status; do not record OTPs or raw identifiers.

- [ ] **Step 5: Request two-stage code review**

Use `superpowers:requesting-code-review` for spec compliance first, then a whole-diff security/release review. Resolve all Critical/Important findings and rerun affected tests.

- [ ] **Step 6: Run final verification before any completion claim**

Use `superpowers:verification-before-completion`, rerun the full commands from Steps 2-4, inspect `git diff --check`, `git status --short`, and the exact diff against `origin/main`.

Expected: no unrelated root-checkout files, no secrets, no production data, no failing tests, and no unreviewed schema privilege expansion.

- [ ] **Step 7: Stop at the release boundary**

Report the verified worktree/branch, changed files, test results, residual risks, and exact production steps. Do not commit, push, deploy, migrate production, or alter Netlify/Logto/Neon production state until the user explicitly authorizes those actions in that turn.
