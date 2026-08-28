import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  randomToken,
  tokenHash,
  emailLookupHash,
  encryptSecret,
  decryptSecret
} from "../../netlify/functions/_shared/auth/crypto.mjs";

const KEY_ENV = {
  AUTH_HMAC_KEY: "hmac-key-01234567890123456789012",
  AUTH_ENCRYPTION_KEY: "encryption-key-01234567890123456",
  AUTH_ENCRYPTION_KEY_VERSION: "1"
};
const savedEnvironment = new Map(
  Object.keys(KEY_ENV).map((name) => [name, process.env[name]])
);

before(() => {
  for (const [name, value] of Object.entries(KEY_ENV)) process.env[name] = value;
});

after(() => {
  for (const [name, value] of savedEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("randomToken returns a 32-byte opaque base64url token", () => {
  const token = randomToken();

  assert.equal(typeof token, "string");
  assert.match(token, /^[A-Za-z0-9_-]+$/u);
  assert.equal(Buffer.from(token, "base64url").length, 32);
});

test("tokenHash stores SHA-256 bytes and never returns the original token", async () => {
  const hash = await tokenHash("abc");

  assert.equal(Buffer.isBuffer(hash), true);
  assert.equal(
    hash.toString("hex"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
  assert.notEqual(hash.toString("utf8"), "abc");
});

test("emailLookupHash uses the separately configured HMAC key", async () => {
  const first = await emailLookupHash("user@example.com");
  const second = await emailLookupHash("user@example.com");
  const different = await emailLookupHash("other@example.com");

  assert.equal(first.length, 32);
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, different);
  assert.notEqual(first.toString("utf8"), "user@example.com");
});

test("encryptSecret binds environment and key version, and decryptSecret rejects tampering", async () => {
  const options = {
    environmentId: "stage",
    siteId: "site-stage",
    keyVersion: 1
  };
  const ciphertext = await encryptSecret("refresh-token", options);

  assert.equal(Buffer.isBuffer(ciphertext), true);
  assert.notEqual(ciphertext.toString("utf8"), "refresh-token");
  assert.equal(await decryptSecret(ciphertext, options), "refresh-token");

  await assert.rejects(
    () => decryptSecret(ciphertext, { ...options, environmentId: "production" }),
    /AUTH_CIPHERTEXT_ENV_MISMATCH/
  );
  await assert.rejects(
    () => decryptSecret(ciphertext, { ...options, encryptionKey: "wrong-key" }),
    /AUTH_KEY_INVALID|AUTH_CIPHERTEXT_INVALID/
  );

  const tampered = Buffer.from(ciphertext);
  tampered[tampered.length - 1] ^= 1;
  await assert.rejects(
    () => decryptSecret(tampered, options),
    /AUTH_CIPHERTEXT_INVALID/
  );
});

test("cryptographic keys must be exactly 32 bytes and independent", async () => {
  await assert.rejects(
    () => emailLookupHash("user@example.com", { hmacKey: "short" }),
    /AUTH_KEY_INVALID/
  );
  await assert.rejects(
    () => encryptSecret("secret", { encryptionKey: "short", environmentId: "stage", siteId: "site-stage" }),
    /AUTH_KEY_INVALID/
  );
  await assert.rejects(
    () => encryptSecret("secret", {
      hmacKey: "same-key-01234567890123456789012",
      encryptionKey: "same-key-01234567890123456789012",
      environmentId: "stage",
      siteId: "site-stage"
    }),
    /AUTH_KEYS_NOT独立|AUTH_KEYS_NOT_INDEPENDENT|AUTH_KEY_INVALID/
  );
});

test("key encodings are canonical base64/base64url and reject appended invalid characters", async () => {
  const hmacBytes = Buffer.alloc(32, 0x11);
  const encryptionBytes = Buffer.alloc(32, 0x22);
  const options = {
    environmentId: "stage",
    siteId: "site-stage",
    keyVersion: 1,
    hmacKey: `base64:${hmacBytes.toString("base64")}`,
    encryptionKey: `base64url:${encryptionBytes.toString("base64url")}`
  };
  const ciphertext = await encryptSecret("canonical-key-test", options);
  assert.equal(await decryptSecret(ciphertext, options), "canonical-key-test");
  await assert.rejects(
    () => encryptSecret("canonical-key-test", {
      ...options,
      hmacKey: `${options.hmacKey}!!!!`
    }),
    /AUTH_KEY_INVALID/
  );
  await assert.rejects(
    () => encryptSecret("canonical-key-test", {
      ...options,
      encryptionKey: `${options.encryptionKey}!!!!`
    }),
    /AUTH_KEY_INVALID/
  );
});

test("encryptSecret rejects empty plaintext instead of creating an undecryptable envelope", async () => {
  await assert.rejects(
    () => encryptSecret("", {
      environmentId: "stage",
      siteId: "site-stage"
    }),
    /AUTH_SECRET_EMPTY/
  );
});
