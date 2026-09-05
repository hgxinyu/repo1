import test from "node:test";
import assert from "node:assert/strict";
import { capabilitiesForAccount } from "../../netlify/functions/_shared/auth/capabilities.mjs";

const cases = [
  ["pending", true, false, false, false],
  ["free", true, false, false, false],
  ["vip", true, true, false, false],
  ["svip", true, true, true, false],
  ["admin", true, true, true, true],
  ["blocked", false, false, false, false]
];

test("role matrix is canonical and blocked wins", () => {
  for (const [role, registered, premium, svip, admin] of cases) {
    const value = capabilitiesForAccount({ role, status: "approved" });
    assert.equal(value.authenticated, true);
    assert.equal(value.role, role);
    assert.equal(value.blocked, role === "blocked");
    assert.equal(value.canAccessRegistered, registered);
    assert.equal(value.canAccessPremium, premium);
    assert.equal(value.canAccessSvip, svip);
    assert.equal(value.isAdmin, admin);
  }
});

test("blocked role wins even with approved status", () => {
  const value = capabilitiesForAccount({ role: "blocked", status: "approved" });
  assert.equal(value.canAccessRegistered, false);
  assert.equal(value.canAccessPremium, false);
  assert.equal(value.isAdmin, false);
});

test("role is normalized before capabilities are evaluated", () => {
  const value = capabilitiesForAccount({ role: " VIP ", status: "approved" });
  assert.equal(value.authenticated, true);
  assert.equal(value.role, "vip");
  assert.equal(value.blocked, false);
  assert.equal(value.canAccessRegistered, true);
  assert.equal(value.canAccessPremium, true);
  assert.equal(value.isAdmin, false);
});

test("blocked status overrides an otherwise privileged role", () => {
  const value = capabilitiesForAccount({ role: "admin", status: "blocked" });
  assert.equal(value.authenticated, true);
  assert.equal(value.role, "admin");
  assert.equal(value.blocked, true);
  assert.equal(value.canAccessRegistered, false);
  assert.equal(value.canAccessPremium, false);
  assert.equal(value.isAdmin, false);
});

test("non-active account statuses are denied even when the role is privileged", () => {
  for (const status of ["disabled", "merged"]) {
    const value = capabilitiesForAccount({ role: "admin", status });
    assert.equal(value.blocked, true);
    assert.equal(value.canAccessRegistered, false);
    assert.equal(value.canAccessPremium, false);
    assert.equal(value.isAdmin, false);
  }
});

test("SVIP is premium and SVIP-capable but never an administrator", () => {
  const value = capabilitiesForAccount({ role: "svip", status: "active" });
  assert.equal(value.canAccessPremium, true);
  assert.equal(value.canAccessSvip, true);
  assert.equal(value.isAdmin, false);
});
