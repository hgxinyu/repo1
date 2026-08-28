import test from "node:test";
import assert from "node:assert/strict";

const CSRF = Buffer.alloc(32, 0xb1).toString("base64url");

function cookieJar(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return {
    get cookie() {
      return [...values].map(([name, value]) => `${name}=${value}`).join("; ");
    },
    set cookie(raw) {
      writes.push(String(raw));
      const pair = String(raw).split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (separator <= 0) return;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1);
      const expired = /(?:^|;)\s*max-age=0(?:;|$)/iu.test(String(raw));
      if (expired || value === "") values.delete(name);
      else values.set(name, value);
    },
    has(name) {
      return values.has(name);
    },
    writes
  };
}

function browserFixture(status, body = null) {
  const storage = new Map([
    ["gotrue.user", JSON.stringify({ id: "legacy-user", email: "user@example.com" })]
  ]);
  const document = cookieJar({
    "__Host-shinegame_csrf": CSRF,
    nf_jwt: "legacy-session",
    nf_refresh: "legacy-refresh"
  });
  const requests = [];
  const window = {
    location: {
      protocol: "https:",
      pathname: "/AIAsk.html",
      search: "",
      hash: ""
    },
    localStorage: {
      getItem(name) {
        return storage.get(name) ?? null;
      },
      removeItem(name) {
        storage.delete(name);
      }
    },
    async fetch(url, options) {
      requests.push({ url, options });
      return body === null
        ? new Response(null, { status })
        : new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" }
        });
    }
  };
  return { window, document, storage, requests };
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

test("auth-session does not call a BFF or Identity API from a file preview", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  let calls = 0;
  globalThis.window = {
    location: {
      protocol: "file:",
      pathname: "/index.html",
      search: "",
      hash: ""
    },
    localStorage: {
      getItem() {
        return null;
      }
    },
    fetch() {
      calls += 1;
      throw new Error("file preview must not fetch");
    }
  };
  globalThis.document = { cookie: "" };

  try {
    const { authFetch, getAuthSession } = await import(
      `../../assets/auth-session.js?file-preview=${Date.now()}`
    );
    assert.deepEqual(await getAuthSession(), {
      authenticated: false,
      accountId: null,
      capabilities: null
    });
    await assert.rejects(() => authFetch("/api/auth/session"), /static preview/);
    assert.equal(calls, 0);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("auth-session retains legacy state when the bridge fails", async () => {
  const fixture = browserFixture(401);
  await withBrowser(fixture, async () => {
    const { bridgeLegacySession } = await import(
      `../../assets/auth-session.js?bridge-failure=${Date.now()}`
    );
    assert.equal(await bridgeLegacySession("/AIAsk.html"), false);
    assert.notEqual(fixture.storage.get("gotrue.user"), undefined);
    assert.equal(fixture.document.has("nf_jwt"), true);
    assert.equal(fixture.document.has("nf_refresh"), true);
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].options.credentials, "include");
    assert.equal(fixture.requests[0].options.redirect, "error");
    assert.equal(fixture.requests[0].options.headers.Accept, "application/json");
  });
});

test("auth-session clears legacy state only after a successful bridge response", async () => {
  const fixture = browserFixture(204);
  await withBrowser(fixture, async () => {
    const { bridgeLegacySession } = await import(
      `../../assets/auth-session.js?bridge-success=${Date.now()}`
    );
    assert.equal(await bridgeLegacySession("/AIAsk.html"), true);
    assert.equal(fixture.storage.get("gotrue.user"), undefined);
    assert.equal(fixture.document.has("nf_jwt"), false);
    assert.equal(fixture.document.has("nf_refresh"), false);
  });
});

test("auth-session bridge sends only the finite current pathname", async () => {
  const fixture = browserFixture(204);
  fixture.window.location.pathname = "/Register.html";
  fixture.window.location.search = "?next=%2FAIAsk.html";
  await withBrowser(fixture, async () => {
    const { bridgeLegacySession } = await import(
      `../../assets/auth-session.js?bridge-safe-next=${Date.now()}`
    );
    assert.equal(await bridgeLegacySession(), true);
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].url, "/api/auth/legacy-bridge?next=%2FRegister.html");
  });
});

test("auth-session bridge bootstraps the __Host CSRF cookie with Secure on localhost", async () => {
  const fixture = browserFixture(204);
  fixture.window.location.protocol = "http:";
  fixture.window.location.origin = "http://localhost:8888";
  fixture.document = cookieJar({
    nf_jwt: "legacy-session",
    nf_refresh: "legacy-refresh"
  });
  await withBrowser(fixture, async () => {
    const { bridgeLegacySession } = await import(
      `../../assets/auth-session.js?bridge-csrf-secure=${Date.now()}`
    );
    assert.equal(await bridgeLegacySession("/AIAsk.html"), true);
    const csrfWrite = fixture.document.writes.find((raw) => raw.startsWith("__Host-shinegame_csrf="));
    assert.match(csrfWrite ?? "", /;\s*path=\/;\s*secure;\s*samesite=lax/iu);
  });
});

test("getAuthMe rejects an authenticated response that omits profileComplete", async () => {
  const accountId = "11111111-1111-4111-8111-111111111111";
  const fixture = browserFixture(200, {
    authenticated: true,
    accountId,
    role: "free",
    canAccessRegistered: true,
    canAccessPremium: false,
    isAdmin: false,
    profile: { status: "active", guild: "iOS Aurora", gameName: "Tester" }
  });
  await withBrowser(fixture, async () => {
    const { getAuthMe } = await import(`../../assets/auth-session.js?profile-missing=${Date.now()}`);
    const state = await getAuthMe();
    assert.equal(state.authenticated, false);
    assert.equal(state.accountId, null);
  });
});

test("getAuthMe preserves a boolean profileComplete in normalized state", async () => {
  const accountId = "11111111-1111-4111-8111-111111111111";
  const fixture = browserFixture(200, {
    authenticated: true,
    accountId,
    role: "free",
    canAccessRegistered: true,
    canAccessPremium: false,
    isAdmin: false,
    profileComplete: true,
    profile: { status: "active", guild: "iOS Aurora", gameName: "Tester" }
  });
  await withBrowser(fixture, async () => {
    const { getAuthMe } = await import(`../../assets/auth-session.js?profile-valid=${Date.now()}`);
    const state = await getAuthMe();
    assert.equal(state.authenticated, true);
    assert.equal(state.profileComplete, true);
    assert.equal(typeof state.profileComplete, "boolean");
  });
});

test("profile onboarding paths only carry an allowlisted destination", async () => {
  const fixture = browserFixture(204);
  await withBrowser(fixture, async () => {
    const { profileOnboardingPath } = await import(`../../assets/auth-session.js?profile-path=${Date.now()}`);
    assert.equal(profileOnboardingPath(), "/Register.html");
    assert.equal(profileOnboardingPath("/"), "/Register.html");
    assert.equal(profileOnboardingPath("/index.html"), "/Register.html");
    assert.equal(profileOnboardingPath("AIAsk.html"), "/Register.html?return_to=AIAsk.html");
    assert.equal(profileOnboardingPath("/AIAsk.html?prompt=ignore"), "/Register.html?return_to=AIAsk.html");
    assert.equal(profileOnboardingPath("https://evil.example/"), "/Register.html");
    assert.equal(profileOnboardingPath("/Register.html?return_to=AIAsk.html"), "/Register.html");
  });
});
