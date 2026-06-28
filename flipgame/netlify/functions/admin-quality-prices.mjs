import { json, requireAdmin } from "./_shared/access.mjs";
import { readQualityPrices, writeQualityPrices } from "./_shared/quality-prices.mjs";

export default async (req) => {
  const admin = await requireAdmin();
  if (admin.response) return admin.response;

  if (req.method === "GET") {
    const prices = await readQualityPrices();
    return json(prices);
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  let body = {};
  try {
    body = await req.json();
  } catch (error) {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    const prices = await writeQualityPrices(body, admin.user && admin.user.email);
    return json({ ok: true, prices });
  } catch (error) {
    return json({ error: error && error.message ? error.message : "Invalid quality prices" }, { status: 400 });
  }
};

export const config = {
  path: "/api/admin/quality-prices"
};
