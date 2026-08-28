import {
  getAuthMe,
  profileOnboardingPath,
  safeAuthRedirectPath
} from "./auth-session.js";

function isPrivateIpv4Host(value) {
  const parts = value.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

/** The documented static preview is file:// or the Python server on :8000. */
export function isStaticMockPreview() {
  if (typeof window === "undefined" || !window.location) return false;
  if (window.location.protocol === "file:") return true;
  const host = (window.location.hostname || "").toLowerCase();
  const localHost = host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || isPrivateIpv4Host(host);
  return localHost && String(window.location.port || "") === "8000";
}

function safeNext(value) {
  return encodeURIComponent(safeAuthRedirectPath(value));
}

/** Decide whether an authenticated non-admin account must finish onboarding. */
export function shouldRedirectToProfileOnboarding(auth, currentPath = "") {
  if (!auth || auth.authenticated !== true || auth.profileComplete !== false) return false;
  const capabilities = auth.capabilities;
  if (!capabilities || capabilities.blocked === true || capabilities.isAdmin === true) return false;
  const path = safeAuthRedirectPath(
    currentPath || (typeof window !== "undefined" && window.location ? window.location.pathname : "/index.html")
  );
  return path !== "/Register.html";
}

function navigateToProfileOnboarding(next) {
  const target = profileOnboardingPath(next);
  if (typeof window.location.assign === "function") window.location.assign(target);
  else window.location.href = target;
  return target;
}

export async function guardVipPage(options = {}) {
  const pageName = options.pageName || "该页面";
  const currentPath = options.currentPath || window.location.pathname || "/index.html";
  const next = options.next || currentPath.split("/").pop() || "index.html";
  const access = options.access === "registered" ? "registered" : "vip";
  const badgeText = access === "registered" ? "会员" : "VIP";
  const isLocalMock = isStaticMockPreview();
  if (!isLocalMock) document.body.classList.add("auth-checking");

  const pageTitle = document.getElementById("pageTitle");
  if (pageTitle && !pageTitle.querySelector(".vip-page-badge")) {
    const badge = document.createElement("span");
    badge.className = "vip-page-badge";
    badge.textContent = badgeText;
    pageTitle.appendChild(badge);
  }

  const style = document.createElement("style");
  style.textContent = `
    .vip-page-badge { display:inline-flex; align-items:center; justify-content:center; vertical-align:middle; margin-left:10px; border:1px solid rgba(194,65,12,.28); border-radius:999px; padding:3px 10px; background:#fff7ed; color:#c2410c; font-size:13px; font-weight:800; line-height:1.4; white-space:nowrap; }
    body.auth-checking .wrap, body.auth-blocked .wrap { display:none !important; }
    .auth-card { width:min(520px,calc(100% - 32px)); margin:104px auto 24px; background:#fff; border:1px solid var(--border,#e5e7eb); border-radius:var(--radius,16px); box-shadow:var(--shadow,0 12px 28px rgba(15,23,42,.12)); padding:clamp(18px,5vw,28px); display:none; flex-direction:column; gap:12px; color:var(--ink,#111827); }
    body.auth-checking .auth-card, body.auth-blocked .auth-card { display:flex; }
    .auth-card h2 { margin:0; font-size:22px; } .auth-card p { margin:0; color:var(--muted,#64748b); font-size:14px; }
    .auth-actions { display:flex; flex-wrap:wrap; gap:10px; margin-top:6px; }
    .auth-actions a, .auth-actions button { border:1px solid rgba(99,102,241,.35); background:#fff; padding:10px 16px; border-radius:14px; color:var(--brand,#6366f1); text-decoration:none; font-size:15px; cursor:pointer; }
    .auth-actions a.primary { background:linear-gradient(135deg,var(--brand,#6366f1),#c2410c); color:#fff; border-color:transparent; }
  `;
  document.head.appendChild(style);

  const card = document.createElement("section");
  card.className = "auth-card";
  card.setAttribute("aria-live", "polite");
  card.innerHTML = `
    <h2 id="authTitle">正在检查权限</h2>
    <p id="authMessage">请稍候...</p>
    <div class="auth-actions" id="authActions" style="display:none;">
      <a class="primary" href="Login.html?next=${safeNext(next)}">登录</a>
      <a href="Register.html?next=${safeNext(next)}">注册账号</a>
      <button id="retryAuthBtn" type="button">重新检查</button>
    </div>
  `;
  document.body.insertBefore(card, document.body.firstElementChild ? document.body.firstElementChild.nextSibling : null);

  const title = card.querySelector("#authTitle");
  const message = card.querySelector("#authMessage");
  const actions = card.querySelector("#authActions");
  const retry = card.querySelector("#retryAuthBtn");

  if (isLocalMock) {
    document.body.classList.remove("auth-checking", "auth-blocked");
    return true;
  }

  async function checkAccess() {
    document.body.classList.add("auth-checking");
    document.body.classList.remove("auth-blocked");
    title.textContent = "正在检查权限";
    message.textContent = "正在恢复登录状态，请稍候...";
    actions.style.display = "none";

    const auth = await getAuthMe();
    if (shouldRedirectToProfileOnboarding(auth, currentPath)) {
      navigateToProfileOnboarding(next);
      return false;
    }
    const capabilities = auth && auth.authenticated ? auth.capabilities : null;
    const canAccess = access === "registered"
      ? Boolean(capabilities && capabilities.canAccessRegistered && !capabilities.blocked)
      : Boolean(capabilities && capabilities.canAccessPremium && !capabilities.blocked);
    if (canAccess) {
      document.body.classList.remove("auth-checking", "auth-blocked");
      return true;
    }

    document.body.classList.remove("auth-checking");
    document.body.classList.add("auth-blocked");
    title.textContent = auth && auth.authenticated ? (access === "registered" ? "账号不可用" : "VIP 权限未开启") : "需要登录";
    message.textContent = auth && auth.authenticated
      ? (access === "registered" ? "你的账号当前不能访问会员页面，请联系管理员。" : "你的账号已登录，但还没有 VIP 权限。请等待管理员审核，或联系管理员开通。")
      : `${pageName} 需要登录后使用，请先登录或注册账号。`;
    actions.style.display = "flex";
    return false;
  }

  retry.addEventListener("click", () => {
    checkAccess().catch(() => {
      document.body.classList.remove("auth-checking");
      document.body.classList.add("auth-blocked");
      title.textContent = "权限检查失败";
      message.textContent = "暂时无法确认登录状态，请稍后重试。";
      actions.style.display = "flex";
    });
  });
  return checkAccess();
}
