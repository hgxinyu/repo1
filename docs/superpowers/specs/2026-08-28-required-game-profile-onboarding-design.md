# Required Game Profile Onboarding Design

> 状态：历史设计／实施计划，不是当前上线行为。2026-09-12 核对：当前 main 的 `Register.html` 仍通过 `/api/vip-request` 同时保存资料和转为 pending，未包含独立 `/api/account/profile` 入口或强制补资料流程。本文件后续步骤、分支和审批安排仅属当时任务；复用前按当前目标重新判断。当前事实见 [VIP 账号与权限](../../vip-access.md)。

Date: 2026-08-28

## Objective

Require every non-admin ShineGame account to provide a game account/name and guild before using authenticated member or VIP features, without granting or requesting VIP as a side effect.

This change must preserve the existing smooth-migration behavior: a verified Logto email may claim the matching legacy account and retain its existing role, status, profile, and permanent `account_id`.

## Current Behavior and Root Cause

- A genuinely new Logto identity creates an `active/free` account. It does not receive VIP.
- A verified email that matches a migrated legacy account claims that existing account and retains its existing role, including VIP or admin.
- The homepage account badge is shown only for accounts with premium/admin capability. Separate `VIP` and `Member` labels on tool cards are static feature labels visible to everyone.
- `accounts.guild` and `accounts.game_name` already exist and are exposed through `/api/me` and the Admin account list.
- `Register.html` already collects both fields, but only users who enter through the registration page see that form. A user entering through `Login.html` can finish authentication and bypass it.
- The current form posts to `/api/vip-request`, which combines profile persistence with a `free -> pending` VIP-request transition. Profile completion and VIP authorization are therefore incorrectly coupled.

## Chosen Product Rules

1. A genuinely new account must complete profile onboarding after its first successful Google or email-code authentication.
2. An existing non-admin account whose game account/name or guild is blank must complete onboarding at its next authenticated visit.
3. Admin accounts are exempt so an incomplete profile can never lock an administrator out of recovery tools.
4. Completing onboarding changes only `guild`, `game_name`, and `updated_at`. It must not change `role`, `status`, `authz_version`, migration ownership, identities, or sessions.
5. Game account/name and guild are both required after trimming. A user without a guild must explicitly enter `无公会` or `No guild`; an empty value is not accepted.
6. Neither field is an identity, account-linking, migration, or authorization key.
7. VIP remains a separate, explicit request followed by administrator approval.

## Architecture

### Profile completeness

The server is the source of truth. A profile is complete when:

- the account is an active admin; or
- both `guild` and `game_name` are non-empty after trimming.

`/api/me` will return a boolean `profileComplete` alongside the existing profile and capability fields. Frontend code may use this boolean for navigation but must not derive a different definition.

The database columns remain nullable. This preserves compatibility with migrated accounts and the atomic OAuth account-creation transaction; completeness is enforced at application boundaries rather than with a `NOT NULL` migration.

### Profile update boundary

Add `POST /api/account/profile` as a same-origin, authenticated, CSRF-protected endpoint.

Request body:

```json
{
  "guild": "Guild name",
  "gameName": "Game account or name"
}
```

Validation:

- require an active, non-blocked authenticated account;
- trim both fields;
- require each value to contain 1 to 100 Unicode characters;
- reject control characters;
- reject arrays, nested objects, unknown payload shapes, and invalid JSON;
- use the session `account_id`; never accept an account ID, email, role, or status from the client.

The repository update must be parameterized and limited to the current account's `guild`, `game_name`, and `updated_at`. The response returns the sanitized canonical profile plus `profileComplete: true`; it does not return encrypted email, provider subject, tokens, or other account data.

The operation is idempotent: repeating the same valid submission is safe and does not increment `authz_version` or revoke sessions.

### Authentication callback and redirect flow

The callback continues to complete account claim/creation and session issuance before onboarding.

After resolving the account:

1. Preserve the allowlisted original `next` path.
2. If the resolved account is admin or already profile-complete, redirect to that path unchanged.
3. Otherwise redirect to `/Register.html` with the allowlisted destination encoded as the existing finite `return_to` value.

The callback must never include arbitrary external URLs in `return_to`. Existing `safeNextPath` behavior remains the only redirect allowlist.

This applies equally to fresh Google registration, fresh email-code registration, and migrated non-admin accounts with incomplete profiles.

### Ongoing enforcement

First-login redirect alone is insufficient because a user can close the page or navigate directly.

- The shared authenticated frontend bootstrap will redirect incomplete non-admin accounts to the onboarding page before showing authenticated account controls.
- Registered-member and VIP guards will treat an incomplete profile as requiring onboarding before checking member or premium access.
- Protected authenticated APIs that serve member/VIP functionality will fail closed with a stable `PROFILE_INCOMPLETE` response before performing the requested operation.
- `Admin.html` and admin APIs remain accessible to active admins regardless of profile completeness.
- Public calculators, guides, login, privacy, terms, and the onboarding page remain accessible without profile completion.

The onboarding page must recognize itself as the destination and avoid redirect loops.

### Registration page behavior

`Register.html` becomes the account-profile onboarding page after authentication:

- unauthenticated users still see Google and email-code entry choices;
- authenticated incomplete users see the required profile form;
- authenticated complete users see their existing values and may update them;
- the primary submit copy becomes “保存账号资料” / “Save account profile”;
- successful save returns to the safe original destination;
- saving does not mention VIP review and does not call `/api/vip-request`.

VIP application remains a separate action. `/api/vip-request` will verify the already-saved canonical profile and perform only the explicit `free -> pending` request transition. It will no longer accept or persist `guild` or `gameName`, and it must not be invoked automatically after onboarding.

### Existing and migrated accounts

- Migrated accounts retain their permanent account ID and role.
- Existing non-admin accounts with both fields populated see no interruption.
- Existing non-admin accounts missing either field are sent to onboarding on their next authenticated visit.
- Active admins are exempt even when one or both fields are blank.
- Blocked, disabled, or merged accounts remain blocked and cannot use profile onboarding to restore access.

## Error Handling

- Anonymous request: sanitized `401`.
- Missing or invalid CSRF/origin: sanitized `403`.
- Blocked/disabled/merged account: existing fail-closed authorization response.
- Empty, oversized, control-character, or malformed fields: sanitized `400` with stable validation code.
- Database unavailable: sanitized `503`; no partial role or profile change.
- Concurrent updates: last complete valid submission wins; each update remains atomic.

Frontend messages must be localized in Chinese and English and must not expose SQL, provider errors, account IDs, or internal exception text.

## Testing

Automated coverage must include:

1. Fresh Google and email-code accounts are created `free/active`, receive no premium capability, and redirect to onboarding.
2. A migrated VIP email claims the same account and preserves VIP; complete migrated profiles continue directly.
3. A migrated non-admin account with missing data is redirected to onboarding without creating another account or changing role.
4. Admin accounts bypass onboarding and retain Admin access.
5. Profile API success persists both fields while role, status, `authz_version`, migration ID, identities, and sessions remain unchanged.
6. Anonymous, bad-origin, missing-CSRF, blocked, malformed, blank, oversized, control-character, and unknown-field requests fail closed.
7. Repeated and concurrent valid submissions remain safe.
8. `/api/me` returns the canonical `profileComplete` value.
9. Frontend flow preserves only allowlisted `return_to` paths, avoids loops, and redirects incomplete accounts from registered/VIP guards.
10. Free and pending accounts do not show the account-level VIP badge; static tool-card badges remain clearly feature labels.
11. Existing explicit VIP request reads the already-saved profile, changes only eligible `free` accounts to `pending`, rejects incomplete profiles, and cannot be triggered by profile save.

Run the full auth test suite, function syntax checks, PostgreSQL repository/schema smoke tests against a disposable or Neon development branch, and a local browser flow for fresh Google and email-code accounts before production release.

## Rollout

1. Implement and test against the current `origin/main` authentication source of truth, not the stale local `main` checkout.
2. Apply no schema migration unless implementation discovers a missing privilege required by the existing least-privilege BFF role. Any privilege change must be narrowly scoped to profile columns/functions.
3. Validate on the Neon development branch with synthetic accounts and no production PII.
4. Verify fresh-account onboarding, migrated-account compatibility, admin exemption, logout, and Admin account listing locally.
5. Update `docs/vip-access.md` in Chinese/English-facing behavior where applicable.
6. Commit, push, and production deploy only after an explicit current-turn user request, following repository release rules.

## Out of Scope

- Changing Logto connectors or hosted UI fields.
- Using game account/name or guild for identity matching.
- Automatically granting or requesting VIP.
- Supporting multiple game accounts or multiple guild memberships.
- Adding Apple, QQ, or WeChat authentication.
- Changing existing legacy-account merge semantics.
