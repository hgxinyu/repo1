# VIP Application Redirect and Login Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Return successful VIP applications to the homepage while preserving the current session, and show administrators each account's latest successful login time and coarse location.

**Architecture:** Keep the existing first-party cookie and `/api/vip-request` boundary. Add login metadata to the account record and update it atomically with first-party session creation on the Logto and legacy bridge success paths. Extend the existing admin account list contract and render one responsive “last login” cell.

**Tech Stack:** Static HTML modules, Netlify Functions, Node ESM tests, PostgreSQL migrations, Playwright browser fixtures.

**Spec:** `docs/superpowers/specs/2026-09-14-vip-redirect-login-metadata.md`

## Global Constraints

- Preserve unrelated dirty worktree changes and do not stage, commit, push, deploy, or apply a real database migration in this task.
- Keep the configured first-party Logto/BFF authentication architecture; do not add client-side credentials or replace the session cookie.
- Store UTC timestamps and only coarse geo fields; never store raw IP, exact address, device fingerprint, or browser-supplied location.
- Keep admin list access behind `isAdmin`; do not expose login metadata through `/api/me` or regular-member pages.
- Follow TDD: add each behavior test, run it red, implement the smallest change, then run it green.

---

### Task 1: Lock the contracts with failing tests

**Files:**
- Modify: `flipgame/test/auth/frontend-auth.test.mjs`
- Modify: `flipgame/test/auth/protected-api-auth.test.mjs`
- Modify: `flipgame/test/auth/auth-functions.test.mjs`
- Modify: `flipgame/test/auth/session-repository.test.mjs`
- Modify: `flipgame/test/auth/account-repository.test.mjs`
- Modify: `flipgame/test/auth/schema.test.mjs`
- Modify: `flipgame/test/admin-workspace.test.mjs`
- Create: `flipgame/test/auth/login-metadata.test.mjs`

**Interfaces:**
- Consumes: existing `Register.html`, auth callback/session repository, account list contract, and admin browser fixture.
- Produces: explicit failing assertions for redirect behavior, geo normalization, atomic login recording, admin API fields, migration columns/grants, and responsive rendering.

- [x] **Step 1: Add the frontend contract assertion.** Assert that the successful VIP submit path navigates to `safeReturnTarget()` even when the default target is `/index.html`, and that it uses same-origin navigation rather than clearing or replacing credentials.
- [x] **Step 2: Add the geo-normalization tests.** Cover a Netlify context with `US`/`California`/`San Jose`, missing geo, and overlong/untrusted values; expect bounded nullable `{ country, region, city }` output.
- [x] **Step 3: Add the session repository red test.** Give `createAppSession` login metadata and assert its SQL transaction performs the login-field update after the session insert; assert a normal session without metadata does not update accounts.
- [x] **Step 4: Add callback and bridge input assertions.** Assert Logto callback and legacy bridge pass normalized geo metadata into session creation, while an anonymous/missing context records time with null location.
- [x] **Step 5: Add API/account contract assertions.** Extend account fixtures with login fields and assert `GET /api/admin/users` returns the timestamp and structured location but `/api/me` remains unchanged.
- [x] **Step 6: Add migration assertions.** Assert the incremental migration is transactional, adds the four nullable account columns, and grants the BFF only the four-column update needed for login recording.
- [x] **Step 7: Add browser fixture assertions.** Give one mock user a login record and one no record; assert both labels render and the 390px layout remains within the viewport.
- [x] **Step 8: Run the focused red suite.** The focused suite was run before implementation and showed the expected red behavior assertions.

### Task 2: Add schema and repository login fields

**Files:**
- Create: `database/migrations/202609140001_account_login_metadata.sql`
- Modify: `flipgame/netlify/functions/_shared/auth/account-repository.mjs`
- Modify: `flipgame/test/auth/schema.test.mjs`
- Modify: `flipgame/test/auth/account-repository.test.mjs`

**Interfaces:**
- Consumes: the existing `accounts` table and `shinegame_auth_bff` runtime role.
- Produces: mapped account properties `lastLoginAt`, `lastLoginCountry`, `lastLoginRegion`, and `lastLoginCity`, plus a migration that permits only those metadata updates.

- [x] **Step 1: Add the nullable columns and constraints.** Create a transactional migration with bounded text checks for country, region, and city; do not backfill or overwrite existing accounts.
- [x] **Step 2: Add least-privilege runtime access.** Grant the BFF `UPDATE (last_login_at, last_login_country, last_login_region, last_login_city)` and no role/status/account-identity mutation; keep existing table-wide SELECT behavior.
- [x] **Step 3: Extend account projections.** Add the four columns to `ACCOUNT_COLUMNS` and `ACCOUNT_RETURNING_COLUMNS`, and map them to camelCase nullable properties.
- [x] **Step 4: Run repository and schema tests.** Repository/schema assertions pass in the focused and complete suites.

### Task 3: Record successful login metadata atomically

**Files:**
- Create: `flipgame/netlify/functions/_shared/auth/login-metadata.mjs`
- Modify: `flipgame/netlify/functions/_shared/auth/session-repository.mjs`
- Modify: `flipgame/netlify/functions/auth-callback.mjs`
- Modify: `flipgame/netlify/functions/auth-legacy-bridge.mjs`
- Modify: `flipgame/test/auth/login-metadata.test.mjs`
- Modify: `flipgame/test/auth/session-repository.test.mjs`
- Modify: `flipgame/test/auth/auth-functions.test.mjs`
- Modify: `flipgame/test/auth/legacy-bridge.test.mjs`

**Interfaces:**
- Consumes: Netlify function `context.geo` and the parsed session creation timestamp.
- Produces: `readLoginLocation(context)` returning nullable bounded fields, and `createAppSession({ loginLocation })`/bridge session input that updates account metadata in the same SQL transaction as session creation.

- [x] **Step 1: Implement bounded geo normalization.** Read only `context.geo.country.code`, `context.geo.subdivision.name`/`code`, and `context.geo.city`; trim, normalize country codes to uppercase, bound each field, and return nulls for missing values.
- [x] **Step 2: Add the atomic account update.** In the session repository, after inserting `auth_sessions` and before returning, update only the four login columns when the caller supplies `loginLocation`; use the repository clock's `parsed.now` for `last_login_at` and fail the transaction if the account update does not affect exactly one account.
- [x] **Step 3: Pass metadata from both login boundaries.** Change the Netlify function entrypoints to accept the second context argument and pass `readLoginLocation(context)` into Logto and legacy bridge session creation. Keep regular session refresh/read paths untouched.
- [x] **Step 4: Run the focused auth tests.** Focused auth tests pass, including callback, bridge, metadata, and session repository coverage.

### Task 4: Expose the data through the admin API

**Files:**
- Modify: `flipgame/netlify/functions/admin-users.mjs`
- Modify: `flipgame/test/auth/protected-api-auth.test.mjs`
- Modify: `flipgame/test/auth/migration-freeze-endpoints.test.mjs`

**Interfaces:**
- Consumes: mapped account login properties from Task 2.
- Produces: admin-only JSON fields `lastLoginAt` and `lastLoginLocation: { country, region, city } | null`.

- [x] **Step 1: Add the public admin projection.** Include nullable timestamp and structured location in `publicAccount`; omit no existing fields and do not add them to `/api/me`.
- [x] **Step 2: Cover both repository return shapes.** The projection reads the mapped account fields used by both repository list paths and remains null-safe.
- [x] **Step 3: Run protected endpoint tests.** Protected endpoint assertions pass and non-admin behavior remains denied.

### Task 5: Fix VIP navigation and update admin UI

**Files:**
- Modify: `flipgame/Register.html`
- Modify: `flipgame/Admin.html`
- Modify: `flipgame/test/auth/frontend-auth.test.mjs`
- Modify: `flipgame/test/admin-workspace.test.mjs`

**Interfaces:**
- Consumes: existing safe return target, admin API fields, and static mock mode.
- Produces: successful VIP submission navigation to the homepage/default target and a responsive last-login cell with bilingual-safe fallback values.

- [x] **Step 1: Make successful VIP submission navigate.** On a 2xx response, keep the success status briefly, then call `window.location.assign(safeReturnTarget())` for all safe targets including `/index.html`; on failure re-enable the form and stay put.
- [x] **Step 2: Preserve login state by construction.** Do not touch session/local storage or add a second authentication request; rely on the existing same-origin cookie and homepage `getAuthMe()` load.
- [x] **Step 3: Render login information safely.** Add one “上次登录” column, escape all values, format the timestamp with existing `formatDate`, compose city/region/country, and render “从未登录” / “位置未知” for null values.
- [x] **Step 4: Update mock and responsive layout.** Add representative login data to local mock users, increase empty-row colspan, and make the new cell full-width on narrow screens without horizontal overflow.
- [x] **Step 5: Run frontend and browser tests.** Frontend contracts pass; the admin browser suite passes all 7 tests at desktop and narrow widths.

### Task 6: Document privacy and complete verification

**Files:**
- Modify: `flipgame/Privacy.html`
- Modify: `docs/vip-access.md`
- Modify: `docs/account-diagnostics.md`
- Modify: `docs/superpowers/specs/2026-09-14-vip-redirect-login-metadata.md`

**Interfaces:**
- Consumes: implemented API and storage behavior from Tasks 2–5.
- Produces: user-facing privacy wording and maintainer documentation for field semantics and migration order.

- [x] **Step 1: Update bilingual privacy text.** State that limited sign-in metadata may include coarse country/region/city, not raw IP or exact address, and that it is used for security/admin operations.
- [x] **Step 2: Update auth documentation.** Document the post-submit redirect/session behavior, admin response fields, and keep the distinction from `last_seen_at` explicit in the design and auth docs.
- [x] **Step 3: Run the complete verification set.** `npm test`, JavaScript syntax checks, the focused browser test, PostgreSQL migration smoke, and `git diff --check` all pass.
- [x] **Step 4: Inspect the final diff boundary.** Confirmed unrelated knowledge-base, guide-image, output, and planning files remain present and unstaged.

## Verification Checklist

- [x] Focused red tests were observed before implementation.
- [x] Focused auth/API/UI tests pass after implementation.
- [x] Full project tests pass.
- [x] Database migration SQL is statically checked; no real database or production account was written.
- [x] Admin browser layout passes at desktop and narrow widths.
- [x] `git diff --check` passes.
- [x] No commit, push, deploy, or production migration was performed.
