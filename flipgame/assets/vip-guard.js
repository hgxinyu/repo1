import { getUser, handleAuthCallback } from "https://esm.sh/@netlify/identity?bundle";

export async function guardVipPage(options = {}) {
  const pageName = options.pageName || "该页面";
  const next = options.next || window.location.pathname.split("/").pop() || "index.html";

  const style = document.createElement("style");
  style.textContent = `
    body.auth-checking .wrap,
    body.auth-blocked .wrap { display: none !important; }
    .auth-card {
      width: min(520px, calc(100% - 32px));
      margin: 104px auto 24px;
      background: #fff;
      border: 1px solid var(--border, #e5e7eb);
      border-radius: var(--radius, 16px);
      box-shadow: var(--shadow, 0 12px 28px rgba(15, 23, 42, 0.12));
      padding: clamp(18px, 5vw, 28px);
      display: none;
      flex-direction: column;
      gap: 12px;
      color: var(--ink, #111827);
    }
    body.auth-checking .auth-card,
    body.auth-blocked .auth-card { display: flex; }
    .auth-card h2 { margin: 0; font-size: 22px; }
    .auth-card p { margin: 0; color: var(--muted, #64748b); font-size: 14px; }
    .auth-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 6px; }
    .auth-actions a,
    .auth-actions button {
      border: 1px solid rgba(99, 102, 241, 0.35);
      background: #fff;
      padding: 10px 16px;
      border-radius: 14px;
      color: var(--brand, #6366f1);
      text-decoration: none;
      font-size: 15px;
      cursor: pointer;
    }
    .auth-actions a.primary {
      background: linear-gradient(135deg, var(--brand, #6366f1), #c2410c);
      color: #fff;
      border-color: transparent;
    }
  `;
  document.head.appendChild(style);

  const card = document.createElement("section");
  card.className = "auth-card";
  card.setAttribute("aria-live", "polite");
  card.innerHTML = `
    <h2 id="authTitle">正在检查 VIP 权限</h2>
    <p id="authMessage">请稍候...</p>
    <div class="auth-actions" id="authActions" style="display:none;">
      <a class="primary" href="Login.html?next=${encodeURIComponent(next)}">登录</a>
      <a href="Register.html">注册账号</a>
      <button id="retryAuthBtn" type="button">重新检查</button>
    </div>
  `;
  document.body.insertBefore(card, document.body.firstElementChild ? document.body.firstElementChild.nextSibling : null);

  const title = card.querySelector("#authTitle");
  const message = card.querySelector("#authMessage");
  const actions = card.querySelector("#authActions");
  const retry = card.querySelector("#retryAuthBtn");

  async function checkAccess() {
    document.body.classList.add("auth-checking");
    document.body.classList.remove("auth-blocked");
    title.textContent = "正在检查 VIP 权限";
    message.textContent = "请稍候...";
    actions.style.display = "none";

    await handleAuthCallback().catch(() => null);
    const user = await getUser().catch(() => null);
    if (!user) {
      document.body.classList.remove("auth-checking");
      document.body.classList.add("auth-blocked");
      title.textContent = "需要登录";
      message.textContent = `${pageName} 是 VIP 专属页面，请先登录或注册账号提交审核。`;
      actions.style.display = "flex";
      return false;
    }

    const response = await fetch("/api/me", { credentials: "include" });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.canAccessPremium) {
      document.body.classList.remove("auth-checking", "auth-blocked");
      return true;
    }

    document.body.classList.remove("auth-checking");
    document.body.classList.add("auth-blocked");
    title.textContent = "VIP 权限未开启";
    message.textContent = "你的账号已登录，但还没有 VIP 权限。请等待管理员审核，或联系管理员开通。";
    actions.style.display = "flex";
    return false;
  }

  retry.addEventListener("click", () => {
    checkAccess().catch((error) => {
      document.body.classList.remove("auth-checking");
      document.body.classList.add("auth-blocked");
      title.textContent = "权限检查失败";
      message.textContent = error.message || String(error);
      actions.style.display = "flex";
    });
  });

  return checkAccess();
}
