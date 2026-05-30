import { getUsersStore, json, publicProfile, requireAdmin } from "./_shared/access.mjs";

export default async () => {
  const admin = await requireAdmin();
  if (admin.response) return admin.response;

  const store = getUsersStore();
  const { blobs } = await store.list({ prefix: "users/" });
  const rows = [];
  for (const blob of blobs) {
    const profile = await store.get(blob.key, { type: "json" });
    if (profile) rows.push(publicProfile(profile));
  }

  rows.sort((a, b) => String(b.requestedAt || b.createdAt || "").localeCompare(String(a.requestedAt || a.createdAt || "")));
  return json({ users: rows });
};

export const config = {
  path: "/api/admin/users"
};
