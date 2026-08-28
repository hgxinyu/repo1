import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  deleteProfile,
  legacyProfileWriteErrorResponse,
  legacyProfileWritesFrozen,
  writeProfile
} from "../netlify/functions/_shared/access.mjs";

function setWriteMode(value) {
  globalThis.Netlify = { env: { get: (name) => name === "MIGRATION_WRITE_MODE" ? value : "" } };
}

test("frozen mode blocks legacy Blob writes before store access", async (t) => {
  t.after(() => { delete globalThis.Netlify; });
  setWriteMode("frozen");

  assert.equal(legacyProfileWritesFrozen(), true);
  for (const operation of [
    () => writeProfile({ email: "synthetic@example.invalid" }),
    () => deleteProfile("synthetic@example.invalid")
  ]) {
    await assert.rejects(operation, (error) => {
      assert.equal(error.code, "LEGACY_WRITE_FROZEN");
      const response = legacyProfileWriteErrorResponse(error);
      assert.equal(response.status, 503);
      return true;
    });
  }
});

test("account mode does not report legacy writes as frozen", (t) => {
  t.after(() => { delete globalThis.Netlify; });
  setWriteMode("account");
  assert.equal(legacyProfileWritesFrozen(), false);
  assert.equal(legacyProfileWriteErrorResponse(new Error("other")), null);
});

test("every production legacy write handler maps the freeze error", async () => {
  const handlers = ["vip-request.mjs", "me.mjs", "admin-users.mjs", "admin-set-role.mjs", "admin-delete-user.mjs"];
  for (const filename of handlers) {
    const source = await readFile(new URL(`../netlify/functions/${filename}`, import.meta.url), "utf8");
    assert.match(source, /legacyProfileWriteErrorResponse/u, filename);
  }
});
