import { timingSafeEqual } from "node:crypto";
import { admin as identityAdmin } from "@netlify/identity";
import { json } from "./_shared/access.mjs";

const EXPECTED_SITE_ID = "34bfd812-74b4-4f9c-ac20-97ab0cefe996";
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

function env(name) {
  const configured = typeof Netlify !== "undefined" && Netlify.env ? Netlify.env.get(name) : "";
  const runtime = typeof process !== "undefined" && process.env ? process.env[name] : "";
  return String(configured || runtime || "");
}

function exportResponse(data, status) {
  return json(data, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "Pragma": "no-cache"
    }
  });
}

export function authorizedExportToken(authorization, expectedToken) {
  const match = /^Bearer\s+(.+)$/u.exec(String(authorization || ""));
  const actual = Buffer.from(match ? match[1] : "", "utf8");
  const expected = Buffer.from(String(expectedToken || ""), "utf8");
  return expected.length >= 43 && actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function normalizeIdentityExportUser(user) {
  const id = String(user?.id || "").trim();
  const email = String(user?.email || "").trim().toLowerCase();
  const confirmedAt = String(user?.confirmed_at || user?.confirmedAt || "").trim() || null;
  const explicitVerified = user?.email_verified ?? user?.emailVerified;
  return {
    id,
    email,
    email_verified: typeof explicitVerified === "boolean" ? explicitVerified : Boolean(confirmedAt),
    confirmed_at: confirmedAt
  };
}

export async function listIdentityUsers(identityAdminClient = identityAdmin) {
  const users = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const rows = await identityAdminClient.listUsers({ page, perPage: PAGE_SIZE });
    if (!Array.isArray(rows)) throw new Error("IDENTITY_PAGE_INVALID");
    users.push(...rows.map(normalizeIdentityExportUser));
    if (rows.length < PAGE_SIZE) break;
    if (page === MAX_PAGES) throw new Error("IDENTITY_PAGINATION_LIMIT");
  }
  if (users.some((user) => !user.id || !user.email)) throw new Error("IDENTITY_USER_INVALID");
  if (new Set(users.map(({ id }) => id)).size !== users.length) throw new Error("IDENTITY_USER_DUPLICATE");
  return users.sort((left, right) => left.id.localeCompare(right.id));
}

export function createMigrationExportHandler({ identityAdminClient = identityAdmin, envReader = env } = {}) {
  return async (req) => {
    if (req.method !== "GET") return exportResponse({ error: "Method not allowed" }, 405);
    if (
      envReader("AUTH_ENV_ID") !== "production" ||
      envReader("CONTEXT") !== "production" ||
      envReader("MIGRATION_WRITE_MODE") !== "frozen" ||
      envReader("SITE_ID") !== EXPECTED_SITE_ID
    ) {
      return exportResponse({ error: "Not available" }, 404);
    }
    if (!authorizedExportToken(req.headers.get("authorization"), envReader("AUTH_MIGRATION_EXPORT_TOKEN"))) {
      return exportResponse({ error: "Unauthorized" }, 401);
    }

    try {
      return exportResponse({ identityUsers: await listIdentityUsers(identityAdminClient) }, 200);
    } catch {
      return exportResponse({ error: "Identity export temporarily unavailable" }, 503);
    }
  };
}

export default createMigrationExportHandler();

export const config = {
  path: "/api/auth-migration-export"
};
