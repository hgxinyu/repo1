import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import test from "node:test";

test("a hidden account badge has no rendered box", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const browser = await chromium.launch({ channel: "chrome", headless: true });

  try {
    const page = await browser.newPage();
    await page.setContent(html);
    const rendering = await page.evaluate(() => {
      const menu = document.getElementById("accountMenu");
      const badge = document.getElementById("accountVipBadge");
      menu.style.display = "inline-flex";
      badge.hidden = true;
      const rect = badge.getBoundingClientRect();
      return {
        display: getComputedStyle(badge).display,
        width: rect.width,
        height: rect.height
      };
    });

    assert.deepEqual(rendering, { display: "none", width: 0, height: 0 });
  } finally {
    await browser.close();
  }
});
