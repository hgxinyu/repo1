import assert from "node:assert/strict";
import test from "node:test";

async function loadScreenshotValidation() {
  try {
    return await import("../assets/recruitment-screenshot.mjs");
  } catch (error) {
    assert.fail(`recruitment screenshot validation is unavailable: ${error && error.code ? error.code : error}`);
  }
}

test("a recruitment application requires a backpack screenshot", async () => {
  const { recruitmentScreenshotIssue } = await loadScreenshotValidation();

  assert.equal(recruitmentScreenshotIssue(null), "required");
});

test("recruitment screenshots accept PNG and JPEG files up to 10 MB", async () => {
  const { recruitmentScreenshotIssue } = await loadScreenshotValidation();

  assert.equal(recruitmentScreenshotIssue({ type: "image/png", size: 10 * 1024 * 1024 }), "");
  assert.equal(recruitmentScreenshotIssue({ type: "image/jpeg", size: 4 * 1024 * 1024 }), "");
});

test("recruitment screenshots reject unsupported files and files over 10 MB", async () => {
  const { recruitmentScreenshotIssue } = await loadScreenshotValidation();

  assert.equal(recruitmentScreenshotIssue({ type: "image/webp", size: 1024 }), "type");
  assert.equal(recruitmentScreenshotIssue({ type: "image/png", size: 10 * 1024 * 1024 + 1 }), "size");
});
