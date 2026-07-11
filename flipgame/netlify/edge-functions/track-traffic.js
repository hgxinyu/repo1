import { getStore } from "@netlify/blobs";

const STORE_NAME = "site-traffic";

function isPageRequest(request) {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/.netlify/")) return false;
  const destination = request.headers.get("sec-fetch-dest");
  if (destination && destination !== "document") return false;
  const lastPart = url.pathname.split("/").pop() || "";
  return !lastPart.includes(".") || /\.html?$/i.test(lastPart);
}

function pageName(pathname) {
  if (pathname === "/" || pathname === "/index.html") return "/";
  return pathname.replace(/\/+$/, "") || "/";
}

export default async (request, context) => {
  if (!isPageRequest(request)) return context.next();

  const response = await context.next();
  if (!response || response.status >= 400) return response;

  try {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const hour = now.toISOString().slice(11, 13);
    const country = String(context.geo?.country?.code || "ZZ").toUpperCase();
    const path = pageName(new URL(request.url).pathname);
    const key = `visits/${day}/${hour}/${country}.json`;
    const store = getStore({ name: STORE_NAME, consistency: "strong" });
    const current = await store.get(key, { type: "json" }).catch(() => null);
    const paths = current && typeof current.paths === "object" ? current.paths : {};
    await store.setJSON(key, {
      date: day,
      hour,
      country,
      views: Number(current?.views || 0) + 1,
      paths: { ...paths, [path]: Number(paths[path] || 0) + 1 },
      updatedAt: now.toISOString()
    });
  } catch (error) {
    console.log("Traffic tracking skipped:", error?.message || error);
  }

  return response;
};

export const config = {
  path: "/*",
  method: ["GET"],
  onError: "bypass"
};
