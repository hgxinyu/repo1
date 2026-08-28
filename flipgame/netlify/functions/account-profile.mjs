import { authJson } from "./_shared/auth/http.mjs";
import {
  authErrorResponse,
  assertBrowserWriteRequest,
  createAuthRuntime,
  requireRequestCapability
} from "./_shared/auth/runtime.mjs";
import {
  normalizeAccountProfile,
  profileCompleteForAccount
} from "./_shared/auth/account-profile.mjs";

function canonicalProfile(account, primaryEmailMasked = "") {
  return {
    guild: typeof account?.guild === "string" ? account.guild : "",
    gameName: typeof account?.gameName === "string" ? account.gameName : "",
    status: typeof account?.status === "string" ? account.status : "",
    primaryEmailMasked: typeof primaryEmailMasked === "string" ? primaryEmailMasked : ""
  };
}

export function createAccountProfileHandler(overrides = {}) {
  const runtime = createAuthRuntime(overrides);
  const json = overrides.json || authJson;

  return async function accountProfileHandler(request) {
    if (request?.method !== "POST") {
      return json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "POST" } });
    }

    let context;
    try {
      assertBrowserWriteRequest(request, overrides);
      ({ context } = await requireRequestCapability(
        runtime,
        request,
        "canAccessRegistered",
        { allowIncompleteProfile: true }
      ));
    } catch (error) {
      return authErrorResponse(error, json, 401);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, { status: 400 });
    }

    let profileInput;
    try {
      profileInput = normalizeAccountProfile(body);
    } catch (error) {
      return authErrorResponse(error, json, 400);
    }

    try {
      const account = await runtime.accountRepository.updateProfile({
        accountId: context.accountId,
        guild: profileInput.guild,
        gameName: profileInput.gameName
      });
      let primaryEmailMasked = "";
      if (typeof runtime.accountRepository?.getPrimaryEmailMasked === "function") {
        primaryEmailMasked = await runtime.accountRepository.getPrimaryEmailMasked(context.accountId);
      }
      return json({
        ok: true,
        profile: canonicalProfile(account, primaryEmailMasked),
        profileComplete: profileCompleteForAccount(account)
      });
    } catch (error) {
      return authErrorResponse(error, json, 503);
    }
  };
}

export default async function accountProfile(request) {
  return createAccountProfileHandler()(request);
}

export const config = {
  path: "/api/account/profile"
};
