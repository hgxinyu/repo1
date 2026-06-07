import { admin as identityAdmin } from "@netlify/identity";
import { getEmailConfirmedAt, getEmailVerified, getUsersStore, json, normalizeEmail, publicProfile, requireAdmin, writeProfile } from "./_shared/access.mjs";

async function listIdentityUsersByEmail() {
  try {
    const users = await identityAdmin.listUsers();
    return {
      usersByEmail: new Map((users || []).map((user) => [normalizeEmail(user && user.email), user]).filter(([email]) => email)),
      error: ""
    };
  } catch (error) {
    return {
      usersByEmail: new Map(),
      error: error && error.message ? error.message : "Unable to read Netlify Identity users"
    };
  }
}

export default async () => {
  const admin = await requireAdmin();
  if (admin.response) return admin.response;

  const store = getUsersStore();
  const { usersByEmail: identityUsersByEmail, error: identitySyncError } = await listIdentityUsersByEmail();
  const { blobs } = await store.list({ prefix: "users/" });
  const rows = [];
  for (const blob of blobs) {
    let profile = await store.get(blob.key, { type: "json" });
    if (!profile) continue;

    const identityUser = identityUsersByEmail.get(normalizeEmail(profile.email));
    const emailVerified = getEmailVerified(identityUser);
    const emailConfirmedAt = getEmailConfirmedAt(identityUser);
    if (typeof emailVerified === "boolean" && (profile.emailVerified !== emailVerified || (emailConfirmedAt && !profile.emailConfirmedAt))) {
      profile = await writeProfile({
        ...profile,
        emailVerified,
        emailConfirmedAt: emailVerified ? (profile.emailConfirmedAt || emailConfirmedAt || new Date().toISOString()) : profile.emailConfirmedAt || ""
      });
    }

    rows.push(publicProfile(profile));
  }

  rows.sort((a, b) => String(b.requestedAt || b.createdAt || "").localeCompare(String(a.requestedAt || a.createdAt || "")));
  return json({ users: rows, identitySyncError });
};

export const config = {
  path: "/api/admin/users"
};
