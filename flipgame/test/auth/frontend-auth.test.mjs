import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), "utf8");
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
      capabilities: { authenticated: true, role: "vip", blocked: false, canAccessRegistered: true, canAccessPremium: true, isAdmin: false }
    });
    assert.equal(session.accountId, accountId);
    assert.equal(session.capabilities.canAccessPremium, true);
    const me = auth.normalizeAuthState({
      authenticated: true,
      accountId,
      role: "free",
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
  assert.match(register, /\/api\/vip-request/);
  assert.match(register, /authFetch/);
  assert.match(register, /callbackNext[\s\S]*Register\.html/);
  assert.match(register, /returnPath\.slice\(1\)/);
  assert.doesNotMatch(register, /body:\s*JSON\.stringify\(\{[^}]*\b(?:email|emailVerified|role)\b/);
  const docs = read("../docs/vip-access.md");
  assert.match(docs, /\/api\/auth\/session/);
  assert.match(docs, /X-CSRF-Token/);
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


test("SVIP session preserves inherited VIP access and rejects forged SVIP capability", async () => {
  const { normalizeAuthState } = await import("../../assets/auth-session.js");
  const state = {
    authenticated: true, accountId: "11111111-1111-4111-8111-111111111111", role: "svip", status: "active",
    capabilities: { authenticated: true, role: "svip", blocked: false, canAccessRegistered: true, canAccessPremium: true, canAccessSvip: true, isAdmin: false }
  };
  const normalized = normalizeAuthState(state);
  assert.equal(normalized.authenticated, true);
  assert.equal(normalized.capabilities.canAccessPremium, true);
  assert.equal(normalized.capabilities.canAccessSvip, true);
  assert.equal(normalized.capabilities.isAdmin, false);
  for (const role of ["free", "pending", "vip"]) {
    assert.equal(normalizeAuthState({ ...state, role, capabilities: { ...state.capabilities, role, canAccessPremium: role === "vip" } }).authenticated, false);
  }
  for (const canAccessSvip of [false, undefined, "true", 1]) {
    assert.equal(normalizeAuthState({ ...state, capabilities: { ...state.capabilities, canAccessSvip } }).authenticated, false);
  }
  assert.equal(normalizeAuthState({ ...state, status: "blocked" }).authenticated, false);
});
