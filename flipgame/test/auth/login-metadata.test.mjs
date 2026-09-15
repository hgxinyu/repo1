import test from "node:test";
import assert from "node:assert/strict";

import { readLoginLocation } from "../../netlify/functions/_shared/auth/login-metadata.mjs";

test("login location keeps only coarse Netlify geo fields", () => {
  assert.deepEqual(readLoginLocation({
    geo: {
      country: { code: "us" },
      subdivision: { name: "California", code: "CA" },
      city: "San Jose"
    }
  }), {
    country: "US",
    region: "California",
    city: "San Jose"
  });
});

test("missing or malformed geo becomes nullable metadata without throwing", () => {
  assert.deepEqual(readLoginLocation(), { country: null, region: null, city: null });
  assert.deepEqual(readLoginLocation({ geo: { country: { code: "" }, city: {} } }), {
    country: null,
    region: null,
    city: null
  });
});

test("login location bounds untrusted context values", () => {
  const longValue = "x".repeat(300);
  const result = readLoginLocation({
    geo: {
      country: { code: "u<script" },
      subdivision: { name: longValue },
      city: `  San   Jose  ${longValue} `
    }
  });
  assert.equal(result.country, null);
  assert.equal(result.region.length <= 128, true);
  assert.equal(result.city.length <= 128, true);
  assert.equal(result.city.includes("<"), false);
});
