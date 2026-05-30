import { json, normalizeEmail, readProfile, statusForRole, writeProfile } from "./_shared/access.mjs";

export default async (req) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  let body = {};
  try {
    body = await req.json();
  } catch (error) {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }

  const email = normalizeEmail(body.email);
  const guild = String(body.guild || "").trim();
  const gameName = String(body.gameName || "").trim();

  if (!email || !email.includes("@")) {
    return json({ error: "Valid email is required" }, { status: 400 });
  }
  if (!guild || !gameName) {
    return json({ error: "Guild and game name are required" }, { status: 400 });
  }

  const existing = await readProfile(email);
  const now = new Date().toISOString();
  const profile = await writeProfile({
    ...(existing || {}),
    email,
    guild,
    gameName,
    role: existing && existing.role ? existing.role : "pending",
    status: existing && existing.status ? existing.status : statusForRole("pending"),
    createdAt: existing && existing.createdAt ? existing.createdAt : now,
    requestedAt: now
  });

  return json({ ok: true, profile });
};

export const config = {
  path: "/api/vip-request"
};
