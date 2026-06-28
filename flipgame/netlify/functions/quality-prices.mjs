import { json } from "./_shared/access.mjs";
import { readQualityPrices } from "./_shared/quality-prices.mjs";

export default async () => {
  const prices = await readQualityPrices();
  return json(prices);
};

export const config = {
  path: "/api/quality-prices"
};
