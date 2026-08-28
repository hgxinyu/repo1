import { admin as identityAdmin } from "@netlify/identity";
import { deleteProfile, getEmailConfirmedAt, getEmailVerified, json, legacyProfileWriteErrorResponse, normalizeEmail, readProfile, requireAdmin } from "./_shared/access.mjs";

async function readIdentityUser(email) {
  try {
    const users = await identityAdmin.listUsers();
    return {
      user: (users || []).find((user) => normalizeEmail(user && user.email) === email) || null,
      error: ""
    };
  } catch (error) {
    return {
      user: null,
      error: error && error.message ? error.message : "Unable to read Netlify Identity users"
    };
  }
}

function isConfirmed(profile, identityUser) {
  if (getEmailConfirmedAt(identityUser)) return true;
  if (getEmailVerified(identityUser) === true) return true;
  if (profile && profile.emailConfirmedAt) return true;
  return profile && profile.emailVerified === true;
}

export default async (req) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const admin = await requireAdmin();
  if (admin.response) return admin.response;

  let body = {};
  try {
    body = await req.json();
  } catch (error) {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }

  const email = normalizeEmail(body.email);
  if (!email || !email.includes("@")) {
    return json({ error: "Valid email is required" }, { status: 400 });
  }

  const existing = await readProfile(email);
  if (!existing) {
    return json({ error: "User request not found" }, { status: 404 });
  }

  const { user: identityUser, error: identityError } = await readIdentityUser(email);
  if (identityError) {
    return json({ error: `Unable to verify email confirmation status: ${identityError}` }, { status: 502 });
  }
  if (isConfirmed(existing, identityUser)) {
    return json({ error: "Confirmed accounts cannot be deleted here" }, { status: 409 });
  }

  try {
    await deleteProfile(email);
  } catch (error) {
    const response = legacyProfileWriteErrorResponse(error);
    if (response) return response;
    throw error;
  }
  return json({ ok: true });
};

export const config = {
  path: "/api/admin/delete-user"
};
