import { canAccessPremium, currentUser, getEmailConfirmedAt, getEmailVerified, isAdminEmail, json, normalizeEmail, publicProfile, readProfile, writeProfile } from "./_shared/access.mjs";

export default async () => {
  const user = await currentUser();
  const email = normalizeEmail(user && user.email);
  if (!email) {
    return json({ authenticated: false, canAccessPremium: false }, { status: 401 });
  }

  let profile = await readProfile(email);
  const emailVerified = getEmailVerified(user);
  const identityConfirmedAt = getEmailConfirmedAt(user);
  const emailConfirmedAt = identityConfirmedAt || (emailVerified ? new Date().toISOString() : "");
  if (profile && typeof emailVerified === "boolean" && (profile.emailVerified !== emailVerified || (emailConfirmedAt && !profile.emailConfirmedAt))) {
    profile = await writeProfile({
      ...profile,
      emailVerified,
      emailConfirmedAt: emailVerified ? (profile.emailConfirmedAt || emailConfirmedAt) : profile.emailConfirmedAt || ""
    });
  }
  const isAdmin = isAdminEmail(email);
  return json({
    authenticated: true,
    email,
    isAdmin,
    canAccessPremium: canAccessPremium(profile, email),
    profile: publicProfile(profile) || {
      email,
      role: isAdmin ? "admin" : "free",
      status: isAdmin ? "approved" : "pending",
      emailVerified
    }
  });
};

export const config = {
  path: "/api/me"
};
