import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import test from "node:test";

async function loadRouting() {
  try {
    return await import("../assets/guide-image-routing.mjs");
  } catch (error) {
    assert.fail(`weekly guide routing module is unavailable: ${error && error.code ? error.code : error}`);
  }
}

test("weekly-current query is the only query that requests automatic opening", async () => {
  const { shouldOpenCurrentWeeklyGuide } = await loadRouting();

  assert.equal(shouldOpenCurrentWeeklyGuide("?guide=weekly-current"), true);
  assert.equal(shouldOpenCurrentWeeklyGuide("?guide=weekly-current&from=home"), true);
  assert.equal(shouldOpenCurrentWeeklyGuide("?guide=older-week"), false);
  assert.equal(shouldOpenCurrentWeeklyGuide(""), false);
});

test("guide image routing selects the English image only for English users", async () => {
  const { localizedGuideImageList } = await loadRouting();
  const card = {
    image: "images/weekly-event-2026-08-28.jpg",
    imageEn: "images/weekly-event-2026-08-28-en.jpg"
  };

  assert.deepEqual(localizedGuideImageList(card, "zh"), ["images/weekly-event-2026-08-28.jpg"]);
  assert.deepEqual(localizedGuideImageList(card, "en"), ["images/weekly-event-2026-08-28-en.jpg"]);
  assert.deepEqual(localizedGuideImageList({ image: "images/shared.jpg" }, "en"), ["images/shared.jpg"]);
});

test("the weekly event guide is the first homepage navigation card", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html);
    const firstCard = page.locator("#navGrid > .card-link").first();

    assert.equal(await firstCard.getAttribute("href"), "GuideImages.html?guide=weekly-current");
    assert.equal((await firstCard.locator(".title").textContent())?.trim(), "周活动攻略");
  } finally {
    await browser.close();
  }
});
