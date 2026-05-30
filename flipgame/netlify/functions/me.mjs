import { canAccessPremium, currentUser, isAdminEmail, json, normalizeEmail, publicProfile, readProfile } from "./_shared/access.mjs";

export default async () => {
  const user = await currentUser();
  const email = normalizeEmail(user && user.email);
  if (!email) {
    return json({ authenticated: false, canAccessPremium: false }, { status: 401 });
  }

  const profile = await readProfile(email);
  const isAdmin = isAdminEmail(email);
  return json({
    authenticated: true,
    email,
    isAdmin,
    canAccessPremium: canAccessPremium(profile, email),
    profile: publicProfile(profile) || {
      email,
      role: isAdmin ? "admin" : "free",
      status: isAdmin ? "approved" : "pending"
    }
  });
};

export const config = {
  path: "/api/me"
};
