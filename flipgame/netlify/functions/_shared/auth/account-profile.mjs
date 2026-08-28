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
