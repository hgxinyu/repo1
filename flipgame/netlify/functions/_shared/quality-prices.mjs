import { getStore } from "@netlify/blobs";

const STORE_NAME = "quality-prices";
const CURRENT_KEY = "current.json";
const CANONICAL_TIERS = ["C-", "C", "C+", "B-", "B", "B+", "A-", "A", "A+", "S", "SS", "SSS"];

export const DEFAULT_QUALITY_PRICES = {
  source: "manual-json",
  starDiamondBoundDiamondRatio: 5,
  tiers: [
    { tier: "C-", foodPrice: 20, keptPrice: 20 },
    { tier: "C", foodPrice: 30, keptPrice: 30 },
    { tier: "C+", foodPrice: 40, keptPrice: 40 },
    { tier: "B-", foodPrice: 60, keptPrice: 60 },
    { tier: "B", foodPrice: 140, keptPrice: 140 },
    { tier: "B+", foodPrice: 530, keptPrice: 530 },
    { tier: "A-", foodPrice: 3100, keptPrice: 6000 },
    { tier: "A", foodPrice: 6100, keptPrice: 10000 },
    { tier: "A+", foodPrice: 12500, keptPrice: 15000 },
    { tier: "S", foodPrice: 26000, keptPrice: 50000 },
    { tier: "SS", foodPrice: 61000, keptPrice: 100000 },
    { tier: "SSS", foodPrice: 160000, keptPrice: 200000 }
  ]
};

export function normalizeTierName(value) {
  return String(value || "").trim().toUpperCase();
}

export function normalizeQualityPrices(input) {
  const source = input && typeof input === "object" ? input : {};
  const ratio = Number(source.starDiamondBoundDiamondRatio);
  if (!Number.isFinite(ratio) || ratio <= 0) {
    throw new Error("starDiamondBoundDiamondRatio must be greater than 0");
  }

  const rawRows = Array.isArray(source.tiers) ? source.tiers : [];
  const byTier = new Map();
  for (const row of rawRows) {
    const tier = normalizeTierName(row && row.tier);
    if (!tier) continue;
    if (!CANONICAL_TIERS.includes(tier)) {
      throw new Error(`Unsupported tier: ${tier}`);
    }
    const foodPrice = Number(row.foodPrice);
    const keptPrice = Number(row.keptPrice);
    if (!Number.isFinite(foodPrice) || foodPrice < 0) {
      throw new Error(`${tier} foodPrice must be 0 or greater`);
    }
    if (!Number.isFinite(keptPrice) || keptPrice < 0) {
      throw new Error(`${tier} keptPrice must be 0 or greater`);
    }
    byTier.set(tier, { tier, foodPrice, keptPrice });
  }

  const missing = CANONICAL_TIERS.filter((tier) => !byTier.has(tier));
  if (missing.length) {
    throw new Error(`Missing tiers: ${missing.join(", ")}`);
  }

  return {
    source: String(source.source || "admin").trim() || "admin",
    starDiamondBoundDiamondRatio: ratio,
    tiers: CANONICAL_TIERS.map((tier) => byTier.get(tier))
  };
}

export function defaultQualityPrices() {
  return {
    ...normalizeQualityPrices(DEFAULT_QUALITY_PRICES),
    updatedAt: "",
    updatedBy: "",
    storage: "static-default"
  };
}

export function getQualityPriceStore() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

export async function readQualityPrices() {
  try {
    const store = getQualityPriceStore();
    const stored = await store.get(CURRENT_KEY, { type: "json" });
    if (stored) {
      return {
        ...normalizeQualityPrices(stored),
        updatedAt: stored.updatedAt || "",
        updatedBy: stored.updatedBy || "",
        storage: "blob"
      };
    }
  } catch (error) {
    return {
      ...defaultQualityPrices(),
      storage: "static-default",
      storageError: error && error.message ? error.message : "Unable to read quality price store"
    };
  }
  return defaultQualityPrices();
}

export async function writeQualityPrices(input, adminEmail) {
  const now = new Date().toISOString();
  const payload = {
    ...normalizeQualityPrices(input),
    source: "admin",
    updatedAt: now,
    updatedBy: String(adminEmail || "").trim()
  };
  const store = getQualityPriceStore();
  await store.setJSON(CURRENT_KEY, payload);
  return {
    ...payload,
    storage: "blob"
  };
}
