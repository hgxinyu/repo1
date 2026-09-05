import { getStore as defaultGetStore } from "@netlify/blobs";
import { authJson } from "./_shared/auth/http.mjs";
import {
  authErrorResponse,
  createAuthRuntime,
  requireRequestCapability
} from "./_shared/auth/runtime.mjs";

const STORE_NAME = "site-traffic";
const ALLOWED_RANGES = new Set([7, 30, 90]);
const BLOB_READ_CONCURRENCY = 8;

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function requestedDays(request) {
  const value = Number(new URL(request.url).searchParams.get("days"));
  return ALLOWED_RANGES.has(value) ? value : 30;
}

async function listAllBlobs(store, prefix) {
  const blobs = [];
  const source = store.list({ prefix, paginate: true });
  if (source && typeof source[Symbol.asyncIterator] === "function") {
    for await (const listing of source) {
      if (!listing || !Array.isArray(listing.blobs)) throw new Error("Invalid analytics Blob listing");
      blobs.push(...listing.blobs);
    }
  } else {
    const listing = await source;
    if (!listing || !Array.isArray(listing.blobs)) throw new Error("Invalid analytics Blob listing");
    blobs.push(...listing.blobs);
  }
  return blobs;
}

async function readBlobsBounded(store, blobs) {
  const records = new Array(blobs.length);
  let nextIndex = 0;
  let failed = false;
  async function worker() {
    while (true) {
      if (failed) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= blobs.length) return;
      try {
        records[index] = await store.get(blobs[index].key, { type: "json" });
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(BLOB_READ_CONCURRENCY, blobs.length) }, worker));
  return records;
}

export function createAdminTrafficHandler(overrides = {}) {
  const runtime = createAuthRuntime(overrides);
  const json = overrides.json || authJson;
  const getStore = overrides.getStore || defaultGetStore;

  return async function adminTraffic(request) {
    try {
      await requireRequestCapability(runtime, request, "isAdmin");
    } catch (error) {
      return authErrorResponse(error, json, 401);
    }
    if (request?.method && request.method !== "GET") {
      return json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "GET" } });
    }

    try {
      const days = requestedDays(request);
      const end = new Date();
      const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
      start.setUTCDate(start.getUTCDate() - days + 1);
      const store = getStore({ name: STORE_NAME, consistency: "strong" });
      const countryTotals = new Map();
      const dailyTotals = new Map();
      const pageTotals = new Map();

      const dayKeys = [];
      for (let offset = 0; offset < days; offset += 1) {
        const date = new Date(start);
        date.setUTCDate(start.getUTCDate() + offset);
        const day = dateKey(date);
        dailyTotals.set(day, 0);
        dayKeys.push(day);
      }

      const dayListings = await Promise.allSettled(
        dayKeys.map((day) => listAllBlobs(store, `visits/${day}/`))
      );
      const rejectedListing = dayListings.find((result) => result.status === "rejected");
      if (rejectedListing) throw rejectedListing.reason;
      const dayBlobs = dayListings.map((result) => result.value);
      const blobRefs = dayKeys.flatMap((day, index) =>
        dayBlobs[index].map((blob) => ({ day, blob }))
      );
      const records = await readBlobsBounded(store, blobRefs.map(({ blob }) => blob));
      for (let index = 0; index < records.length; index += 1) {
        const day = blobRefs[index].day;
        const record = records[index];
        if (!record) continue;
        const views = Number(record.views || 0);
        const country = String(record.country || "ZZ").toUpperCase();
        dailyTotals.set(day, (dailyTotals.get(day) || 0) + views);
        countryTotals.set(country, (countryTotals.get(country) || 0) + views);
        for (const [path, count] of Object.entries(record.paths || {})) {
          pageTotals.set(path, (pageTotals.get(path) || 0) + Number(count || 0));
        }
      }

      const totalViews = [...countryTotals.values()].reduce((sum, value) => sum + value, 0);
      const countries = [...countryTotals.entries()]
        .map(([country, views]) => ({ country, views, share: totalViews ? views / totalViews : 0 }))
        .sort((a, b) => b.views - a.views);
      const pages = [...pageTotals.entries()]
        .map(([path, views]) => ({ path, views }))
        .sort((a, b) => b.views - a.views)
        .slice(0, 10);

      return json({
        days,
        totalViews,
        countryCount: countries.length,
        countries,
        daily: [...dailyTotals.entries()].map(([date, views]) => ({ date, views })),
        pages,
        generatedAt: new Date().toISOString(),
        note: "Hourly counters are approximate when simultaneous requests update the same country bucket."
      });
    } catch (error) {
      return authErrorResponse(error, json, 503);
    }
  };
}

export default async function adminTraffic(request) {
  return createAdminTrafficHandler()(request);
}

export const config = {
  path: "/api/admin/traffic"
};
