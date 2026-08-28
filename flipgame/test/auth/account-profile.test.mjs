import test from "node:test";
import assert from "node:assert/strict";
import {
  profileCompleteForAccount,
  normalizeAccountProfile
} from "../../netlify/functions/_shared/auth/account-profile.mjs";

test("profile completeness exempts active admins only", () => {
  assert.equal(profileCompleteForAccount({ role: "admin", status: "active" }), true);
  assert.equal(profileCompleteForAccount({ role: "vip", status: "active", guild: "", gameName: "Hero" }), false);
  assert.equal(profileCompleteForAccount({ role: "free", status: "active", guild: "Guild", gameName: "Hero" }), true);
  assert.equal(profileCompleteForAccount({ role: "admin", status: "blocked" }), false);
});

test("profile validation trims and rejects unsafe values", () => {
  assert.deepEqual(normalizeAccountProfile({ guild: " Guild ", gameName: " Hero " }), {
    guild: "Guild",
    gameName: "Hero"
  });
  assert.throws(() => normalizeAccountProfile({ guild: "", gameName: "Hero" }), /ACCOUNT_PROFILE_INVALID/);
  assert.throws(() => normalizeAccountProfile({ guild: "Guild", gameName: "x\u0000y" }), /ACCOUNT_PROFILE_INVALID/);
  assert.throws(() => normalizeAccountProfile({ guild: "x".repeat(101), gameName: "Hero" }), /ACCOUNT_PROFILE_INVALID/);
});
