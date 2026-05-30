import { json, normalizeEmail, normalizeRole, readProfile, requireAdmin, statusForRole, writeProfile } from "./_shared/access.mjs";

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
  const role = normalizeRole(body.role);
  if (!email || !email.includes("@")) {
    return json({ error: "Valid email is required" }, { status: 400 });
  }

  const existing = await readProfile(email);
  if (!existing) {
    return json({ error: "User request not found" }, { status: 404 });
  }

  const status = statusForRole(role);
  const now = new Date().toISOString();
  const profile = await writeProfile({
    ...existing,
    role,
    status,
    approvedAt: status === "approved" ? now : existing.approvedAt || "",
    approvedBy: admin.user.email || ""
  });

  return json({ ok: true, profile });
};

export const config = {
  path: "/api/admin/set-role"
};
