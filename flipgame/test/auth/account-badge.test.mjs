import assert from "node:assert/strict";
import test from "node:test";

async function loadBadgePresentation() {
  try {
    return await import("../../assets/account-badge.mjs");
  } catch (error) {
    assert.fail(`account badge presentation is unavailable: ${error && error.code ? error.code : error}`);
  }
}

test("account badge presentation distinguishes free, VIP, and admin roles", async () => {
  const { accountBadgePresentation } = await loadBadgePresentation();

  assert.deepEqual(accountBadgePresentation({ role: "free", canAccessPremium: false, isAdmin: false }), {
    visible: false,
    label: "",
    kind: "none",
    ariaSuffix: ""
  });
  assert.deepEqual(accountBadgePresentation({ role: "vip", canAccessPremium: true, isAdmin: false }), {
    visible: true,
    label: "VIP",
    kind: "vip",
    ariaSuffix: "VIP"
  });
  assert.deepEqual(accountBadgePresentation({ role: "admin", canAccessPremium: true, isAdmin: true }), {
    visible: true,
    label: "ADMIN",
    kind: "admin",
    ariaSuffix: "Admin"
  });
});

test("admin capability wins over inconsistent premium role text", async () => {
  const { accountBadgePresentation } = await loadBadgePresentation();

  assert.equal(accountBadgePresentation({ role: "vip", canAccessPremium: true, isAdmin: true }).label, "ADMIN");
});


test("SVIP has its own badge and admin still takes precedence", async () => {
  const { accountBadgePresentation } = await loadBadgePresentation();
  const capabilities = { role: "svip", canAccessPremium: true, canAccessSvip: true, isAdmin: false };
  assert.deepEqual(accountBadgePresentation(capabilities), { visible: true, label: "SVIP", kind: "svip", ariaSuffix: "SVIP" });
  assert.equal(accountBadgePresentation({ ...capabilities, isAdmin: true }).label, "ADMIN");
});
