import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

const root = resolve(import.meta.dirname, "../..");

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

function homepageBadgeRefreshSource() {
  const html = read("index.html");
  const match = html.match(/function setAccountBadgeText\(\) \{[\s\S]*?\n      \}\n\n      window\.refreshAccountRoleBadge/u);
  assert.ok(match, "homepage must keep an executable account badge refresh function");
  return match[0].replace(/\n\n      window\.refreshAccountRoleBadge$/u, "");
}

function homepageBadgeHarness({ role, badgeOverride = "", displayName = "Hero" }) {
  const attributes = new Map();
  const buttonAttributes = new Map();
  const translations = {
    zh: {
      account_admin_badge: "管理员",
      account_admin_label: "管理员账号",
      vip_badge: "VIP",
      account_vip_label: "VIP 账号"
    },
    en: {
      account_admin_badge: "Admin",
      account_admin_label: "Admin account",
      vip_badge: "VIP",
      account_vip_label: "VIP account"
    }
  };
  const sandbox = {
    currentLang: "zh",
    accountVipBadge: {
      dataset: { accountRole: role, badgeOverride },
      hidden: false,
      textContent: "",
      setAttribute(name, value) { attributes.set(name, String(value)); }
    },
    accountName: { textContent: displayName },
    accountBtn: {
      setAttribute(name, value) { buttonAttributes.set(name, String(value)); }
    }
  };
  sandbox.t = (key) => translations[sandbox.currentLang][key];
  runInNewContext(homepageBadgeRefreshSource(), sandbox, { filename: "index-account-badge.js" });
  return { sandbox, attributes, buttonAttributes };
}

function registerModuleSource() {
  const html = read("Register.html");
  const match = html.match(/<script type="module">([\s\S]*?)<\/script>/u);
  assert.ok(match, "Register must keep an executable module script");
  return match[1].replace(
    /^\s*import\s+\{[\s\S]*?\}\s+from\s+["']\.\/assets\/auth-session\.js["'];\s*/u,
    ""
  );
}

function registerBrowserHarness({ account }) {
  const ids = [
    "homeLink", "pageTitle", "pageDesc", "googleRegister", "emailRegister",
    "profileIntro", "guildLabel", "gameNameLabel", "submitBtn", "pageNote",
    "privacyLink", "termsLink", "profileForm", "authChoices", "guild", "gameName",
    "status", "vipRequestPanel", "vipRequestTitle", "vipRequestIntro", "vipRequestBtn",
    "vipRequestStatus", "continueLink"
  ];
  const elements = new Map();
  for (const id of ids) {
    const listeners = new Map();
    const element = {
      id,
      hidden: false,
      disabled: false,
      value: "",
      textContent: "",
      firstChild: { textContent: "" },
      dataset: {},
      attributes: new Map(),
      addEventListener(type, callback) {
        const callbacks = listeners.get(type) || [];
        callbacks.push(callback);
        listeners.set(type, callbacks);
      },
      setAttribute(name, value) {
        this.attributes.set(name, String(value));
      },
      async dispatch(type, event = {}) {
        const callbacks = listeners.get(type) || [];
        const results = callbacks.map((callback) => callback({
          currentTarget: this,
          preventDefault() {},
          ...event
        }));
        await Promise.all(results);
      }
    };
    elements.set(id, element);
  }

  const calls = [];
  const storage = { getItem() { return null; } };
  const location = {
    protocol: "https:",
    hostname: "stage.example.com",
    port: "",
    origin: "https://stage.example.com",
    pathname: "/Register.html",
    search: "?return_to=AIAsk.html",
    hash: "",
    href: "https://stage.example.com/Register.html?return_to=AIAsk.html"
  };
  const window = {
    location,
    localStorage: storage,
    setTimeout(callback) {
      callback();
      return 1;
    }
  };
  const document = {
    title: "",
    documentElement: {},
    getElementById(id) {
      const element = elements.get(id);
      if (!element) throw new Error(`missing Register fixture element ${id}`);
      return element;
    }
  };
  const profile = { guild: "Saved Guild", gameName: "Saved Hero", status: "active" };
  const authFetch = async (url, options) => {
    calls.push({ url, options });
    if (url === "/api/account/profile") {
      return new Response(JSON.stringify({ ok: true, profile, profileComplete: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url === "/api/vip-request") {
      return new Response(JSON.stringify({
        ok: true,
        profile: { ...profile, role: "pending", authzVersion: 7, migrationId: null }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`unexpected auth fetch ${url}`);
  };
  const sandbox = {
    window,
    document,
    localStorage: storage,
    navigator: { language: "en-US" },
    URL,
    URLSearchParams,
    Response,
    console,
    authFetch,
    getAuthMe: async () => account,
    isStaticMockPreview: () => false,
    profileOnboardingPath: (value) => value === "/index.html" ? "/Register.html" : `/Register.html?return_to=${value.slice(1)}`,
    safeAuthRedirectPath: (value) => {
      const target = value || "/index.html";
      return target.startsWith("/") ? target : `/${target}`;
    }
  };
  runInNewContext(registerModuleSource(), sandbox, { filename: "Register.html" });
  const ready = new Promise((resolveReady) => setImmediate(resolveReady));
  return { account, calls, elements, location, ready };
}

function browserFixture({ cookie = "__Host-shinegame_csrf=csrf-token", response = new Response("{}", { status: 200 }) } = {}) {
  const calls = [];
  const storageWrites = [];
  const navigations = [];
  const storage = {
    getItem() { return null; },
    setItem(...args) { storageWrites.push(["set", ...args]); },
    removeItem(...args) { storageWrites.push(["remove", ...args]); }
  };
  const document = { cookie };
  const window = {
    location: {
      protocol: "https:",
      origin: "https://stage.example.com",
      pathname: "/AIAsk.html",
      search: "",
      hash: "",
      assign(value) { navigations.push(value); }
    },
    localStorage: storage,
    sessionStorage: storage,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return response;
    }
  };
  return { calls, storageWrites, navigations, document, window };
}

async function withBrowser(fixture, callback) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = fixture.window;
  globalThis.document = fixture.document;
  try {
    return await callback();
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
}

test("Login and Register expose only Google/email BFF entrypoints", () => {
  for (const page of ["Login.html", "Register.html"]) {
    const source = read(page);
    assert.match(source, /\/api\/auth\/sign-in/);
    assert.match(source, /connector=google/);
    assert.match(source, /connector=email/);
    assert.doesNotMatch(source, /@netlify\/identity|netlifyIdentity|handleAuthCallback|recovery_token|requestPasswordRecovery|updateUser|\bsignup\b|\bpassword\b/i);
  }
});

test("public auth policy pages are bilingual and linked from login and registration", () => {
  const privacy = read("Privacy.html");
  const terms = read("Terms.html");
  for (const source of [privacy, terms]) {
    assert.match(source, /lang="zh-Hans"/);
    assert.match(source, /flipgame_lang/);
    assert.match(source, /\bzh\s*:/);
    assert.match(source, /\ben\s*:/);
    assert.match(source, /huangxinyu@gmail\.com/);
    assert.match(source, /index\.html/);
  }
  assert.match(privacy, /Logto/);
  assert.match(privacy, /Google/);
  assert.match(privacy, /session/i);
  assert.match(privacy, /account deletion|删除账号/i);
  assert.match(terms, /acceptable use|可接受使用/i);
  assert.match(terms, /account/i);

  for (const page of ["Login.html", "Register.html"]) {
    const source = read(page);
    assert.match(source, /Privacy\.html/);
    assert.match(source, /Terms\.html/);
  }
});

test("shared browser auth client adds CSRF without persisting credentials", async () => {
  const fixture = browserFixture();
  await withBrowser(fixture, async () => {
    const auth = await import(`../../assets/auth-session.js?frontend-client=${Date.now()}`);
    assert.equal(typeof auth.authFetch, "function");
    const response = await auth.authFetch("/api/auth/logout", { method: "POST" });
    assert.equal(response.status, 200);
    assert.equal(fixture.calls.length, 1);
    const request = fixture.calls[0];
    assert.equal(request.options.credentials, "include");
    assert.equal(request.options.headers["X-CSRF-Token"], "csrf-token");
    // The browser supplies Origin for a same-origin POST; JS must not try to
    // set the forbidden Origin header itself.
    assert.equal("Origin" in request.options.headers, false);
    assert.deepEqual(fixture.storageWrites, []);
  });
});

test("logout clears legacy browser state and uses the returned Logto URL for top-level navigation", async () => {
  const endSessionUrl = "https://tenant.logto.app/oidc/session/end?client_id=logto-app&post_logout_redirect_uri=https%3A%2F%2Fstage.example.com%2FLogin.html%3Fauth%3Dlogged-out";
  const fixture = browserFixture({
    response: new Response(JSON.stringify({ ok: true, endSessionUrl }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  });
  await withBrowser(fixture, async () => {
    const auth = await import(`../../assets/auth-session.js?frontend-logout-provider=${Date.now()}`);
    const target = await auth.logout();
    assert.equal(target, endSessionUrl);
    assert.deepEqual(fixture.navigations, [endSessionUrl]);
    assert.deepEqual(fixture.storageWrites, [["remove", "gotrue.user"]]);
  });
});

test("logout rejects an untrusted provider URL and falls back to the fixed local login path", async () => {
  const fixture = browserFixture({
    response: new Response(JSON.stringify({ ok: true, endSessionUrl: "https://evil.example/logout" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  });
  await withBrowser(fixture, async () => {
    const auth = await import(`../../assets/auth-session.js?frontend-logout-fallback=${Date.now()}`);
    const target = await auth.logout();
    assert.equal(target, "/Login.html?auth=logged-out");
    assert.deepEqual(fixture.navigations, ["/Login.html?auth=logged-out"]);
  });
});

test("logout rejects a provider URL whose fixed post-logout origin differs from the current app", async () => {
  const fixture = browserFixture({
    response: new Response(JSON.stringify({
      ok: true,
      endSessionUrl: "https://tenant.logto.app/oidc/session/end?client_id=logto-app&post_logout_redirect_uri=https%3A%2F%2Fevil.example%2FLogin.html%3Fauth%3Dlogged-out"
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  });
  await withBrowser(fixture, async () => {
    const auth = await import(`../../assets/auth-session.js?frontend-logout-origin=${Date.now()}`);
    assert.equal(await auth.logout(), "/Login.html?auth=logged-out");
    assert.deepEqual(fixture.navigations, ["/Login.html?auth=logged-out"]);
  });
});

test("shared browser auth client rejects cross-origin and non-BFF targets", async () => {
  const fixture = browserFixture();
  await withBrowser(fixture, async () => {
    const auth = await import(`../../assets/auth-session.js?frontend-endpoint=${Date.now()}`);
    await assert.rejects(() => auth.authFetch("https://evil.example/api/auth/logout", { method: "POST" }), /relative BFF path|same-origin/);
    await assert.rejects(() => auth.authFetch("//evil.example/api/auth/logout", { method: "POST" }), /relative BFF path|same-origin/);
    await assert.rejects(() => auth.authFetch("/not-api/logout", { method: "POST" }), /relative BFF path|same-origin/);
    assert.equal(fixture.calls.length, 0);
  });
});

test("auth client normalizes malformed and anonymous BFF responses to fail-closed states", async () => {
  const fixture = browserFixture({ response: new Response("not-json", { status: 200 }) });
  await withBrowser(fixture, async () => {
    const auth = await import(`../../assets/auth-session.js?frontend-normalize=${Date.now()}`);
    const state = await auth.getAuthSession();
    assert.deepEqual(state, { authenticated: false, accountId: null, capabilities: null });
  });
});

test("auth client accepts only a strict active account capability shape", async () => {
  const fixture = browserFixture();
  await withBrowser(fixture, async () => {
    const auth = await import(`../../assets/auth-session.js?frontend-valid=${Date.now()}`);
    const accountId = "11111111-1111-4111-8111-111111111111";
    const session = auth.normalizeAuthState({
      authenticated: true,
      accountId: accountId.toUpperCase(),
      role: "vip",
      status: "active",
      profileComplete: true,
      capabilities: { authenticated: true, role: "vip", blocked: false, canAccessRegistered: true, canAccessPremium: true, isAdmin: false }
    });
    assert.equal(session.accountId, accountId);
    assert.equal(session.capabilities.canAccessPremium, true);
    const me = auth.normalizeAuthState({
      authenticated: true,
      accountId,
      role: "free",
      profileComplete: false,
      profile: { status: "active" },
      canAccessRegistered: true,
      canAccessPremium: false,
      isAdmin: false
    });
    assert.equal(me.capabilities.canAccessRegistered, true);
    assert.equal(auth.normalizeAuthState({ authenticated: true, accountId, role: "admin", profile: { status: "disabled" }, canAccessRegistered: true, canAccessPremium: true, isAdmin: true }).authenticated, false);
  });
});

test("static preview classifier keeps :8000 mock-only while :8888 remains BFF-capable", async () => {
  const fixture = browserFixture();
  await withBrowser(fixture, async () => {
    const auth = await import(`../../assets/auth-session.js?frontend-preview=${Date.now()}`);
    fixture.window.location.hostname = "localhost";
    fixture.window.location.port = "8000";
    assert.equal(auth.isStaticMockPreview(), true);
    await assert.rejects(
      () => auth.authFetch("/api/auth/session"),
      /static preview/
    );
    assert.equal(fixture.calls.length, 0);
    fixture.window.location.port = "8888";
    assert.equal(auth.isStaticMockPreview(), false);
  });
});

test("protected pages use capability-driven BFF auth and preserve only the static mock", () => {
  const pages = ["index.html", "Admin.html", "AwakeningRushSimulator.html", "AIAsk.html"];
  for (const page of pages) {
    const source = read(page);
    assert.doesNotMatch(source, /@netlify\/identity|netlifyIdentity|\bcurrentUser\b|nf_jwt/);
  }
  const guard = read("assets/vip-guard.js");
  assert.match(guard, /canAccessRegistered|canAccessPremium/);
  assert.match(guard, /getAuthMe/);
  assert.match(guard, /protocol === ["']file:["']/);
  assert.match(guard, /port.*8000|8000.*port/);
});

test("protected POST consumers use the shared CSRF-aware helper", () => {
  for (const page of ["Admin.html", "AIAsk.html"]) {
    const source = read(page);
    assert.match(source, /authFetch/);
    assert.doesNotMatch(source, /fetch\((?:'|\")\/api\/(?:ai-chat|admin\/)/);
  }
  const register = read("Register.html");
  assert.match(register, /authFetch\("\/api\/account\/profile"/);
  assert.match(register, /authFetch\("\/api\/vip-request"/);
  assert.match(register, /body:\s*JSON\.stringify\(\{\}\)/);
  assert.match(register, /保存账号资料/);
  assert.match(register, /Save account profile/);
  assert.match(register, /申请 VIP/);
  assert.match(register, /Request VIP/);
  assert.match(register, /无公会/);
  assert.match(register, /No guild/);
  assert.match(register, /authFetch/);
  assert.match(register, /profileOnboardingPath/);
  assert.match(register, /profileComplete\s*!==\s*true/);
  assert.doesNotMatch(register, /body:\s*JSON\.stringify\(\{[^}]*\b(?:email|emailVerified|role)\b/);
  const docs = read("../docs/vip-access.md");
  assert.match(docs, /\/api\/auth\/session/);
  assert.match(docs, /X-CSRF-Token/);
});

test("Register keeps profile save separate from one explicit empty VIP request", async () => {
  const harness = registerBrowserHarness({
    account: {
      authenticated: true,
      accountId: "11111111-1111-4111-8111-111111111111",
      role: "free",
      status: "active",
      profileComplete: false,
      profile: { status: "active", guild: "", gameName: "" },
      capabilities: {
        authenticated: true,
        role: "free",
        blocked: false,
        canAccessRegistered: true,
        canAccessPremium: false,
        isAdmin: false
      }
    }
  });
  await harness.ready;

  const { profileForm, guild, gameName, vipRequestBtn, continueLink } = Object.fromEntries(
    ["profileForm", "guild", "gameName", "vipRequestBtn", "continueLink"].map((id) => [id, harness.elements.get(id)])
  );
  guild.value = " Guild ";
  gameName.value = " Hero ";
  await profileForm.dispatch("submit");

  assert.deepEqual(harness.calls.map(({ url }) => url), ["/api/account/profile"]);
  assert.deepEqual(JSON.parse(harness.calls[0].options.body), { guild: "Guild", gameName: "Hero" });
  assert.equal(vipRequestBtn.disabled, false);
  assert.equal(continueLink.href, "/AIAsk.html");

  await vipRequestBtn.dispatch("click");
  assert.deepEqual(harness.calls.map(({ url }) => url), ["/api/account/profile", "/api/vip-request"]);
  assert.equal(harness.calls.filter(({ url }) => url === "/api/vip-request").length, 1);
  assert.deepEqual(JSON.parse(harness.calls[1].options.body), {});
});

test("Register presents terminal VIP states without enabling another request", async () => {
  for (const [role, expectedText] of [
    ["pending", /pending|已提交/iu],
    ["vip", /already|无需重复/iu],
    ["admin", /admin|管理员/iu]
  ]) {
    const harness = registerBrowserHarness({
      account: {
        authenticated: true,
        accountId: "11111111-1111-4111-8111-111111111111",
        role,
        status: "active",
        profileComplete: true,
        profile: { status: "active", guild: "Guild", gameName: "Hero" },
        capabilities: {
          authenticated: true,
          role,
          blocked: false,
          canAccessRegistered: true,
          canAccessPremium: role !== "pending" && role !== "free",
          isAdmin: role === "admin"
        }
      }
    });
    await harness.ready;
    const button = harness.elements.get("vipRequestBtn");
    const status = harness.elements.get("vipRequestStatus");
    assert.equal(button.disabled, true, role);
    assert.match(status.textContent, expectedText, role);
    assert.equal(harness.calls.length, 0, role);
  }
});

test("profile guard redirects incomplete non-admin accounts without looping on Register", async () => {
  const fixture = browserFixture();
  await withBrowser(fixture, async () => {
    const { shouldRedirectToProfileOnboarding } = await import(`../../assets/vip-guard.js?profile-guard=${Date.now()}`);
    const incompleteFree = {
      authenticated: true,
      profileComplete: false,
      capabilities: { role: "free", isAdmin: false, canAccessRegistered: true, canAccessPremium: false, blocked: false }
    };
    const incompleteVip = {
      authenticated: true,
      profileComplete: false,
      capabilities: { role: "vip", isAdmin: false, canAccessRegistered: true, canAccessPremium: true, blocked: false }
    };
    const completeRegistered = {
      authenticated: true,
      profileComplete: true,
      capabilities: { role: "free", isAdmin: false, canAccessRegistered: true, canAccessPremium: false, blocked: false }
    };
    const completePremium = {
      authenticated: true,
      profileComplete: true,
      capabilities: { role: "vip", isAdmin: false, canAccessRegistered: true, canAccessPremium: true, blocked: false }
    };
    const incompleteAdmin = {
      authenticated: true,
      profileComplete: false,
      capabilities: { role: "admin", isAdmin: true, canAccessRegistered: true, canAccessPremium: true, blocked: false }
    };
    assert.equal(shouldRedirectToProfileOnboarding(incompleteFree, "/AIAsk.html"), true);
    assert.equal(shouldRedirectToProfileOnboarding(incompleteVip, "/AIAsk.html"), true);
    assert.equal(shouldRedirectToProfileOnboarding(completeRegistered, "/SoulAscensionCalculator.html"), false);
    assert.equal(shouldRedirectToProfileOnboarding(completePremium, "/AIAsk.html"), false);
    assert.equal(shouldRedirectToProfileOnboarding(incompleteAdmin, "/Admin.html"), false);
    assert.equal(shouldRedirectToProfileOnboarding(incompleteFree, "/Register.html"), false);
  });
});

test("homepage account badge is account-level only while card badges describe feature access", () => {
  const index = read("index.html");
  assert.match(index, /data-feature-access-label/);
  assert.match(index, /feature access|功能访问|工具访问/i);
  assert.match(index, /const hasVipAccess = auth\.capabilities\.canAccessPremium \|\| auth\.capabilities\.isAdmin/);
  assert.doesNotMatch(index, /accountVipBadge\.hidden\s*=\s*![^;]*profileComplete/);
  assert.match(index, /data-member-badge[\s\S]*aria-label/);
  assert.match(index, /data-vip-badge[\s\S]*aria-label/);
});

test("homepage localizes the real account badge for admin and VIP roles without reusing feature badge markers", () => {
  const index = read("index.html");
  const accountBadge = index.match(/<span class="vip-account-badge"[^>]*id="accountVipBadge"[^>]*>/u);

  assert.ok(accountBadge, "homepage must render an account-level role badge");
  assert.match(accountBadge[0], /data-account-role/u);
  assert.doesNotMatch(accountBadge[0], /data-(?:member|vip)-badge/u);
  assert.match(index, /account_admin_badge:\s*'管理员'/u);
  assert.match(index, /account_admin_badge:\s*'Admin'/u);
  assert.match(index, /account_admin_label:\s*'管理员账号'/u);
  assert.match(index, /account_admin_label:\s*'Admin account'/u);
  assert.match(index, /accountVipBadge\.dataset\.accountRole\s*=\s*auth\.capabilities\.isAdmin\s*\?\s*["']admin["']\s*:\s*["']vip["']/u);
  assert.match(index, /const accountBadgeKey\s*=\s*accountVipBadge\.dataset\.accountRole\s*===\s*'admin'\s*\?\s*'account_admin_badge'\s*:\s*'vip_badge'/u);
  assert.match(index, /accountVipBadge\.setAttribute\('title',\s*t\(accountLabelKey\)\)/u);
  assert.match(index, /accountVipBadge\.setAttribute\('aria-label',\s*t\(accountLabelKey\)\)/u);
  assert.match(index, /accountBtn\.setAttribute\('aria-label',\s*`\$\{accountName\.textContent\}\s+\$\{t\(accountLabelKey\)\}`\)/u);
});

test("homepage account badge refresh keeps admin, VIP, and Local Admin labels role-correct across languages", () => {
  const index = read("index.html");
  assert.match(index, /function showLocalAdminPreview\(\)[\s\S]*accountVipBadge\.dataset\.accountRole\s*=\s*["']admin["'][\s\S]*window\.refreshAccountRoleBadge\(\)/u);
  for (const fixture of [
    { role: "admin", expectedZh: "管理员", expectedEn: "Admin", labelZh: "管理员账号", labelEn: "Admin account" },
    { role: "vip", expectedZh: "VIP", expectedEn: "VIP", labelZh: "VIP 账号", labelEn: "VIP account" },
    { role: "admin", badgeOverride: "ADMIN", displayName: "Local Admin", expectedZh: "ADMIN", expectedEn: "ADMIN", labelZh: "管理员账号", labelEn: "Admin account" }
  ]) {
    const { sandbox, attributes, buttonAttributes } = homepageBadgeHarness(fixture);
    sandbox.setAccountBadgeText();
    assert.equal(sandbox.accountVipBadge.textContent, fixture.expectedZh);
    assert.equal(attributes.get("title"), fixture.labelZh);
    assert.equal(attributes.get("aria-label"), fixture.labelZh);
    assert.equal(buttonAttributes.get("aria-label"), `${fixture.displayName || "Hero"} ${fixture.labelZh}`);

    sandbox.currentLang = "en";
    sandbox.setAccountBadgeText();
    assert.equal(sandbox.accountVipBadge.textContent, fixture.expectedEn);
    assert.equal(attributes.get("title"), fixture.labelEn);
    assert.equal(attributes.get("aria-label"), fixture.labelEn);
    assert.equal(buttonAttributes.get("aria-label"), `${fixture.displayName || "Hero"} ${fixture.labelEn}`);
    if (fixture.badgeOverride) {
      assert.doesNotMatch(buttonAttributes.get("aria-label"), /VIP/u);
    }
  }
});

test("Awakening deep links enforce profile onboarding before registered access", () => {
  const awakening = read("AwakeningRushSimulator.html");
  assert.match(awakening, /shouldRedirectToProfileOnboarding/);
  assert.match(awakening, /profileOnboardingPath/);
  assert.match(awakening, /window\.location\.assign\(profileOnboardingPath\(currentPath\)\)/);
  const onboardingCheck = awakening.indexOf("if (shouldRedirectToProfileOnboarding(auth, currentPath)");
  const registeredCheck = awakening.indexOf("auth.capabilities.canAccessRegistered");
  assert.ok(onboardingCheck >= 0 && registeredCheck >= 0 && onboardingCheck < registeredCheck);
  assert.match(awakening, /if \(isLocal\) \{/);
});

test("admin and protected-page contracts use account capabilities, not legacy Identity fields", () => {
  const admin = read("Admin.html");
  assert.match(admin, /data-label="账号状态"/);
  assert.match(admin, /currentAccountId/);
  assert.match(admin, /authzVersion/);
  assert.match(admin, /initializeAdmin/);
  assert.doesNotMatch(admin, /emailVerified|emailConfirmedAt|identitySyncError|data-delete/);

  const awakening = read("AwakeningRushSimulator.html");
  assert.match(awakening, /canAccessRegistered/);
  assert.doesNotMatch(awakening, /canAccessPremium/);
  assert.match(awakening, /Register\.html\?next=AwakeningRushSimulator\.html/);

  const index = read("index.html");
  assert.match(index, /cardAwakeningTitle[\s\S]*member-badge[\s\S]*data-member-badge/);
  assert.match(index, /card_awakening_sub:\s*['"]Registered members/);

  const docs = read("../docs/vip-access.md");
  assert.doesNotMatch(docs, /Registration\s*=\s*Open|Autoconfirm\s*=\s*Off|旧迁移注册页|email allowlist/);
  const packageJson = read("package.json");
  assert.doesNotMatch(packageJson, /@netlify\/identity/);
  assert.doesNotMatch(packageJson, /@netlify\/database/);
});

test("external Neon migrations stay outside Netlify's automatic migration directory", () => {
  assert.equal(existsSync(resolve(root, "netlify/database/migrations")), false);
  assert.equal(existsSync(resolve(root, "database/migrations")), false);
  assert.equal(existsSync(resolve(root, "../database/migrations/202608250001_auth_accounts.sql")), true);
});
