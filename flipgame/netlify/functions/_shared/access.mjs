import { getStore } from "@netlify/blobs";
import { getUser } from "@netlify/identity";

const USER_PREFIX = "users/";
const ROLES = new Set(["pending", "free", "vip", "admin", "blocked"]);

export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(init.headers || {})
    }
  });
}

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export function normalizeRole(role) {
  const clean = String(role || "").trim().toLowerCase();
  return ROLES.has(clean) ? clean : "pending";
}

export function getEmailVerified(user) {
  if (!user || typeof user !== "object") return null;
  if (typeof user.emailVerified === "boolean") return user.emailVerified;
  if (typeof user.email_verified === "boolean") return user.email_verified;
  if (user.user_metadata && typeof user.user_metadata.emailVerified === "boolean") return user.user_metadata.emailVerified;
  return null;
}

export function getUserKey(email) {
  return `${USER_PREFIX}${encodeURIComponent(normalizeEmail(email))}.json`;
}

export function getUsersStore() {
  return getStore({ name: "vip-users", consistency: "strong" });
}

export async function readProfile(email) {
  const store = getUsersStore();
  return await store.get(getUserKey(email), { type: "json" });
}

export async function writeProfile(profile) {
  const store = getUsersStore();
  const email = normalizeEmail(profile.email);
  const data = {
    ...profile,
    email,
    role: normalizeRole(profile.role),
    updatedAt: new Date().toISOString()
  };
  await store.setJSON(getUserKey(email), data);
  return data;
}

export async function currentUser() {
  try {
    return await getUser();
  } catch (error) {
    return null;
  }
}

export function adminEmails() {
  const raw = typeof Netlify !== "undefined" && Netlify.env
    ? Netlify.env.get("ADMIN_EMAILS")
    : "";
  return new Set(String(raw || "").split(",").map(normalizeEmail).filter(Boolean));
}

export function isAdminEmail(email) {
  return adminEmails().has(normalizeEmail(email));
}

export async function requireAdmin() {
  const user = await currentUser();
  const email = normalizeEmail(user && user.email);
  if (!email || !isAdminEmail(email)) {
    return { user: null, response: json({ error: "Admin access required" }, { status: 403 }) };
  }
  return { user, response: null };
}

export function publicProfile(profile) {
  if (!profile) return null;
  return {
    email: profile.email,
    guild: profile.guild || "",
    gameName: profile.gameName || "",
    role: normalizeRole(profile.role),
    status: profile.status || statusForRole(profile.role),
    emailVerified: typeof profile.emailVerified === "boolean" ? profile.emailVerified : null,
    emailConfirmedAt: profile.emailConfirmedAt || "",
    createdAt: profile.createdAt || "",
    requestedAt: profile.requestedAt || "",
    updatedAt: profile.updatedAt || "",
    approvedAt: profile.approvedAt || "",
    approvedBy: profile.approvedBy || ""
  };
}

export function statusForRole(role) {
  const normalized = normalizeRole(role);
  if (normalized === "vip" || normalized === "admin") return "approved";
  if (normalized === "blocked") return "blocked";
  return "pending";
}

export function canAccessPremium(profile, userEmail) {
  const email = normalizeEmail(userEmail || (profile && profile.email));
  if (isAdminEmail(email)) return true;
  const role = normalizeRole(profile && profile.role);
  return (role === "vip" || role === "admin") && (profile.status || statusForRole(role)) === "approved";
}
