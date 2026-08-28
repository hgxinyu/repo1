import { authJson } from "./_shared/auth/http.mjs";
import {
  authErrorResponse,
  createAuthRuntime,
  requireRequestCapability
} from "./_shared/auth/runtime.mjs";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

function requestedLimit(request) {
  const raw = new URL(request.url).searchParams.get("limit");
  if (raw === null || raw === "") return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) return DEFAULT_LIMIT;
  return Math.min(value, MAX_LIMIT);
}

async function publicAccount(account, accountRepository) {
  const row = {
    accountId: account.accountId,
    role: account.role,
    status: account.status,
    authzVersion: account.authzVersion,
    guild: account.guild || "",
    gameName: account.gameName || ""
  };
  if (typeof accountRepository?.getPrimaryEmailMasked === "function") {
    row.primaryEmailMasked = await accountRepository.getPrimaryEmailMasked(account.accountId);
  }
  return row;
}

export function createAdminUsersHandler(overrides = {}) {
  const runtime = createAuthRuntime(overrides);
  const json = overrides.json || authJson;

  return async function adminUsersHandler(request) {
    if (request?.method && request.method !== "GET") {
      return json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "GET" } });
    }
    try {
      await requireRequestCapability(runtime, request, "isAdmin");
      const accounts = await runtime.accountRepository.listAccounts({ limit: requestedLimit(request) });
      const rows = [];
      for (const account of accounts) rows.push(await publicAccount(account, runtime.accountRepository));
      return json({ users: rows });
    } catch (error) {
      return authErrorResponse(error, json, 503);
    }
  };
}

export default async function adminUsers(request) {
  return createAdminUsersHandler()(request);
}

export const config = {
  path: "/api/admin/users"
};
