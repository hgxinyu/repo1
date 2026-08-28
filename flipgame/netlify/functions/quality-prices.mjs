import { authJson } from "./_shared/auth/http.mjs";
import {
  publicQualityPrices,
  readQualityPrices as defaultReadQualityPrices
} from "./_shared/quality-prices.mjs";

export function createQualityPricesHandler(overrides = {}) {
  const json = overrides.json || authJson;
  const readQualityPrices = overrides.readQualityPrices || defaultReadQualityPrices;
  return async function qualityPrices(request) {
    if (request?.method && request.method !== "GET") {
      return json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "GET" } });
    }
    try {
      return json(publicQualityPrices(await readQualityPrices()));
    } catch {
      return json({ error: "QUALITY_PRICES_UNAVAILABLE" }, { status: 503 });
    }
  };
}

export default async function qualityPrices(request) {
  return createQualityPricesHandler()(request);
}

export const config = {
  path: "/api/quality-prices"
};
