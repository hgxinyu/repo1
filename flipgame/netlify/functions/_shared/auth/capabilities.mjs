const ROLES = new Set(["pending", "free", "vip", "admin", "blocked"]);

export function normalizeRole(value) {
  const role = String(value || "").trim().toLowerCase();
  return ROLES.has(role) ? role : "pending";
}

export function capabilitiesForAccount(account) {
  const role = normalizeRole(account && account.role);
  // `approved` is retained only for legacy snapshots; account-mode rows use
  // the canonical `active` status. Merged/disabled rows must fail closed even
  // if a stale privileged role remains on the account.
  const status = String(account?.status || "").trim().toLowerCase();
  const blocked = role === "blocked" || ["blocked", "disabled", "merged"].includes(status);
  return {
    authenticated: true,
    role,
    blocked,
    canAccessRegistered: !blocked,
    canAccessPremium: !blocked && (role === "vip" || role === "admin"),
    isAdmin: !blocked && role === "admin"
  };
}
