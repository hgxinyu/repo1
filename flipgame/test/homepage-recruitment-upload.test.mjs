import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import test from "node:test";

test("the guild recruitment form requires a PNG or JPEG backpack screenshot", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const browser = await chromium.launch({ channel: "chrome", headless: true });

  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 720 } });
    await page.setContent(html);
    const input = page.locator("#recruitRosterScreenshot");

    assert.equal(await input.count(), 1);
    assert.equal(await input.getAttribute("name"), "attachment");
    assert.equal(await input.getAttribute("type"), "file");
    assert.equal(await input.getAttribute("accept"), "image/png,image/jpeg");
    assert.equal(await input.getAttribute("required"), "");

    await page.locator("#recruitPanel").evaluate((element) => {
      element.style.display = "flex";
    });
    assert.equal(await page.locator("#recruitForm").evaluate((element) => getComputedStyle(element).overflowY), "auto");
  } finally {
    await browser.close();
  }
});
