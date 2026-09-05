const NONE = Object.freeze({ visible: false, label: "", kind: "none", ariaSuffix: "" });
const VIP = Object.freeze({ visible: true, label: "VIP", kind: "vip", ariaSuffix: "VIP" });
const SVIP = Object.freeze({ visible: true, label: "SVIP", kind: "svip", ariaSuffix: "SVIP" });
const ADMIN = Object.freeze({ visible: true, label: "ADMIN", kind: "admin", ariaSuffix: "Admin" });

export function accountBadgePresentation(capabilities) {
  const source = capabilities && typeof capabilities === "object" ? capabilities : {};
  if (source.isAdmin === true) return ADMIN;
  if (source.canAccessSvip === true) return SVIP;
  if (source.canAccessPremium === true) return VIP;
  return NONE;
}
