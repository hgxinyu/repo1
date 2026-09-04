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

test("homepage weekly-current routing automatically opens only the current guide", async () => {
  const { currentWeeklyGuideOpenMode, shouldOpenCurrentWeeklyGuide } = await loadRouting();

  assert.equal(shouldOpenCurrentWeeklyGuide("?guide=weekly-current"), true);
  assert.equal(shouldOpenCurrentWeeklyGuide("?guide=weekly-current&from=home"), true);
  assert.equal(shouldOpenCurrentWeeklyGuide("?guide=older-week"), false);
  assert.equal(shouldOpenCurrentWeeklyGuide(""), false);
  assert.equal(currentWeeklyGuideOpenMode("?guide=weekly-current"), "current-only");
  assert.equal(currentWeeklyGuideOpenMode("?guide=weekly-current&from=home"), "current-only");
  assert.equal(currentWeeklyGuideOpenMode("?guide=older-week"), null);
  assert.equal(currentWeeklyGuideOpenMode(""), null);
});

test("guide image routing selects the English image only for English users", async () => {
  const { localizedCurrentGuideImageList, localizedGuideImageList, localizedGuidePickerItems } = await loadRouting();
  const card = {
    image: "images/weekly-event-2026-09-04.jpg",
    imageEn: "images/weekly-event-2026-09-04-en.jpg",
    images: "images/weekly-event-2026-09-04.jpg|images/weekly-event-2026-08-28.jpg",
    imagesEn: "images/weekly-event-2026-09-04-en.jpg|images/weekly-event-2026-08-28-en.jpg",
    labels: "9月4日|8月28日",
    labelsEn: "Sep 4|Aug 28"
  };

  assert.deepEqual(localizedGuideImageList(card, "zh"), [
    "images/weekly-event-2026-09-04.jpg",
    "images/weekly-event-2026-08-28.jpg"
  ]);
  assert.deepEqual(localizedGuideImageList(card, "en"), [
    "images/weekly-event-2026-09-04-en.jpg",
    "images/weekly-event-2026-08-28-en.jpg"
  ]);
  assert.deepEqual(localizedCurrentGuideImageList(card, "zh"), ["images/weekly-event-2026-09-04.jpg"]);
  assert.deepEqual(localizedCurrentGuideImageList(card, "en"), ["images/weekly-event-2026-09-04-en.jpg"]);
  assert.deepEqual(localizedGuidePickerItems(card, "zh"), [
    { image: "images/weekly-event-2026-09-04.jpg", label: "9月4日" },
    { image: "images/weekly-event-2026-08-28.jpg", label: "8月28日" }
  ]);
  assert.deepEqual(localizedGuidePickerItems(card, "en"), [
    { image: "images/weekly-event-2026-09-04-en.jpg", label: "Sep 4" },
    { image: "images/weekly-event-2026-08-28-en.jpg", label: "Aug 28" }
  ]);
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

test("weekly guides share one gallery card while September 4 remains current", async () => {
  const html = await readFile(new URL("../GuideImages.html", import.meta.url), "utf8");
  const browser = await chromium.launch({ channel: "chrome", headless: true });

  try {
    const page = await browser.newPage();
    await page.setContent(html);
    const weeklyCards = page.locator("#guideCards > .weekly-card");
    const currentCard = weeklyCards.first();

    assert.equal(await weeklyCards.count(), 1);
    assert.equal(await currentCard.getAttribute("data-image"), "images/weekly-event-2026-09-04.jpg");
    assert.equal(await currentCard.getAttribute("data-image-en"), "images/weekly-event-2026-09-04-en.jpg");
    assert.equal(await currentCard.getAttribute("data-images"), "images/weekly-event-2026-09-04.jpg|images/weekly-event-2026-08-28.jpg");
    assert.equal(await currentCard.getAttribute("data-images-en"), "images/weekly-event-2026-09-04-en.jpg|images/weekly-event-2026-08-28-en.jpg");
    assert.equal(await currentCard.getAttribute("data-labels"), "9月4日|8月28日");
    assert.equal(await currentCard.getAttribute("data-labels-en"), "Sep 4|Aug 28");
    assert.equal(await page.locator("#weeklyPicker").count(), 1);
    assert.equal(await page.locator('#guideCards > a[href="images/weekly-event-2026-08-28.jpg"]').count(), 0);
  } finally {
    await browser.close();
  }
});

test("a fitted weekly guide stays entirely inside one desktop viewport", async () => {
  const html = await readFile(new URL("../GuideImages.html", import.meta.url), "utf8");
  const browser = await chromium.launch({ channel: "chrome", headless: true });

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.setContent(html);
    await page.evaluate(() => {
      const overlay = document.getElementById("imageOverlay");
      const images = document.getElementById("overlayImages");
      const image = document.createElement("img");
      image.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='2400' height='3200'%3E%3C/svg%3E";
      images.appendChild(image);
      overlay.classList.add("is-open", "is-fit-page");
    });

    const image = page.locator("#overlayImages img");
    await image.evaluate((element) => element.decode());
    const metrics = await page.evaluate(() => {
      const overlay = document.getElementById("imageOverlay");
      const rect = document.querySelector("#overlayImages img").getBoundingClientRect();
      return {
        viewportHeight: window.innerHeight,
        overlayClientHeight: overlay.clientHeight,
        overlayScrollHeight: overlay.scrollHeight,
        imageTop: rect.top,
        imageBottom: rect.bottom
      };
    });

    assert.equal(metrics.overlayScrollHeight <= metrics.overlayClientHeight, true);
    assert.equal(metrics.imageTop >= 0, true);
    assert.equal(metrics.imageBottom <= metrics.viewportHeight, true);
  } finally {
    await browser.close();
  }
});
