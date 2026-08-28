import { createHash, createHmac, webcrypto } from "node:crypto";

const { subtle } = webcrypto;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const ENVELOPE_PREFIX = "sg-auth-v1";
const AES_KEY_BYTES = 32;
const HMAC_KEY_BYTES = 32;
const IV_BYTES = 12;

function authError(code) {
  return new Error(code);
}

function own(object, names) {
  if (!object || typeof object !== "object") return undefined;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(object, name)) return object[name];
  }
  return undefined;
}

function decodeCanonical(value, encoding) {
  if (typeof value !== "string") return null;
  if (encoding === "base64") {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
      return null;
    }
    const bytes = Buffer.from(value, "base64");
    return bytes.toString("base64") === value ? bytes : null;
  }
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) return null;
  const bytes = Buffer.from(value, "base64url");
  return bytes.toString("base64url") === value ? bytes : null;
}

function keyBytes(value, name, expectedBytes) {
  if (value === undefined || value === null || value === "") {
    throw authError(`AUTH_KEY_MISSING:${name}`);
  }

  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    const bytes = Buffer.from(value);
    if (bytes.length !== expectedBytes) throw authError(`AUTH_KEY_INVALID:${name}`);
    return bytes;
  }

  if (typeof value !== "string") throw authError(`AUTH_KEY_INVALID:${name}`);
  const input = value.trim();
  if (!input) throw authError(`AUTH_KEY_MISSING:${name}`);

  let bytes;
  if (input.startsWith("hex:")) {
    if (!/^[0-9a-f]{64}$/iu.test(input.slice(4))) throw authError(`AUTH_KEY_INVALID:${name}`);
    bytes = Buffer.from(input.slice(4), "hex");
  } else if (input.startsWith("base64:")) {
    bytes = decodeCanonical(input.slice(7), "base64");
  } else if (input.startsWith("base64url:")) {
    bytes = decodeCanonical(input.slice(10), "base64url");
  } else if (/^[0-9a-f]{64}$/iu.test(input)) {
    bytes = Buffer.from(input, "hex");
  } else if (decodeCanonical(input, "base64")?.length === expectedBytes) {
    bytes = decodeCanonical(input, "base64");
  } else if (decodeCanonical(input, "base64url")?.length === expectedBytes) {
    bytes = decodeCanonical(input, "base64url");
  } else {
    // A 32-character secret is treated as UTF-8 for compatibility; any
    // other unprefixed non-canonical encoding is rejected below by length.
    bytes = Buffer.from(input, "utf8");
  }

  if (!bytes || bytes.length !== expectedBytes) {
    throw authError(`AUTH_KEY_INVALID:${name}`);
  }
  return Buffer.from(bytes);
}

function resolveKey(options, kind) {
  const envName = kind === "hmac" ? "AUTH_HMAC_KEY" : "AUTH_ENCRYPTION_KEY";
  const aliases = kind === "hmac"
    ? ["hmacKey", "authHmacKey"]
    : ["encryptionKey", "authEncryptionKey"];
  const explicit = own(options, aliases);
  const value = explicit === undefined ? process.env[envName] : explicit;
  const expectedBytes = kind === "hmac" ? HMAC_KEY_BYTES : AES_KEY_BYTES;
  return keyBytes(value, envName, expectedBytes);
}

function assertIndependent(hmacKey, encryptionKey) {
  if (hmacKey && encryptionKey && hmacKey.equals(encryptionKey)) {
    throw authError("AUTH_KEYS_NOT_INDEPENDENT");
  }
}

function resolveEnvironment(options = {}) {
  const environment = own(options, ["environment"]);
  const environmentId = String(
    own(options, ["environmentId", "envId"]) ??
    own(environment, ["environmentId", "envId"]) ??
    process.env.AUTH_ENV_ID ??
    ""
  ).trim();
  const siteId = String(
    own(options, ["siteId"]) ??
    own(environment, ["siteId"]) ??
    process.env.NETLIFY_SITE_ID ??
    process.env.AUTH_EXPECTED_SITE_ID ??
    ""
  ).trim();
  const expectedSiteId = String(
    own(options, ["expectedSiteId"]) ??
    process.env.AUTH_EXPECTED_SITE_ID ??
    ""
  ).trim();

  if (!environmentId) throw authError("AUTH_CONFIG_MISSING:AUTH_ENV_ID");
  if (!siteId) throw authError("AUTH_CONFIG_MISSING:NETLIFY_SITE_ID");
  if (expectedSiteId && expectedSiteId !== siteId) throw authError("AUTH_ENV_MISMATCH:SITE");
  return { environmentId, siteId };
}

function keyVersion(options = {}) {
  const value = own(options, ["keyVersion", "encryptionKeyVersion"]) ??
    process.env.AUTH_ENCRYPTION_KEY_VERSION ?? "1";
  const normalized = String(value).trim();
  if (!/^[1-9][0-9]*$/u.test(normalized)) throw authError("AUTH_KEY_VERSION_INVALID");
  const version = Number(normalized);
  if (!Number.isSafeInteger(version) || version < 1 || version > 0x7fffffff) {
    throw authError("AUTH_KEY_VERSION_INVALID");
  }
  return version;
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function fromBase64url(value) {
  const bytes = decodeCanonical(value, "base64url");
  if (!bytes) {
    throw authError("AUTH_CIPHERTEXT_INVALID");
  }
  return bytes;
}

function aad(environmentId, siteId, version) {
  return textEncoder.encode(JSON.stringify([ENVELOPE_PREFIX, environmentId, siteId, version]));
}

function parseEnvelope(value) {
  const input = Buffer.isBuffer(value)
    ? value.toString("utf8")
    : typeof value === "string" ? value : "";
  const parts = input.split(".");
  if (parts.length !== 3 || parts[0] !== ENVELOPE_PREFIX) {
    throw authError("AUTH_CIPHERTEXT_INVALID");
  }

  let header;
  try {
    header = JSON.parse(fromBase64url(parts[1]).toString("utf8"));
  } catch {
    throw authError("AUTH_CIPHERTEXT_INVALID");
  }
  if (!header || header.v !== 1 ||
      !Number.isSafeInteger(header.k) || header.k < 1 ||
      typeof header.e !== "string" || typeof header.s !== "string" ||
      typeof header.i !== "string") {
    throw authError("AUTH_CIPHERTEXT_INVALID");
  }
  const environmentId = fromBase64url(header.e).toString("utf8");
  const siteId = fromBase64url(header.s).toString("utf8");
  const iv = fromBase64url(header.i);
  const encrypted = fromBase64url(parts[2]);
  if (!environmentId || !siteId || iv.length !== IV_BYTES || encrypted.length <= 16) {
    throw authError("AUTH_CIPHERTEXT_INVALID");
  }
  return { header, environmentId, siteId, iv, encrypted };
}

/** Return a URL-safe token backed by exactly 32 random bytes. */
export function randomToken() {
  const bytes = new Uint8Array(32);
  webcrypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

/** Hash an opaque token before it crosses the database boundary. */
export function tokenHash(token) {
  if (typeof token !== "string" || token.length === 0) throw authError("AUTH_TOKEN_INVALID");
  return createHash("sha256").update(token, "utf8").digest();
}

/** Derive a non-reversible lookup key; the raw email is never persisted. */
export async function emailLookupHash(normalizedEmail, options = {}) {
  if (typeof normalizedEmail !== "string" || normalizedEmail.trim() === "") {
    throw authError("AUTH_EMAIL_INVALID");
  }
  const hmacKey = resolveKey(options, "hmac");
  const encryptionValue = own(options, ["encryptionKey", "authEncryptionKey"]) ??
    process.env.AUTH_ENCRYPTION_KEY;
  const encryptionKey = encryptionValue === undefined || encryptionValue === ""
    ? null
    : keyBytes(encryptionValue, "AUTH_ENCRYPTION_KEY", AES_KEY_BYTES);
  assertIndependent(hmacKey, encryptionKey);
  return createHmac("sha256", hmacKey)
    .update(normalizedEmail.trim().toLowerCase(), "utf8")
    .digest();
}

/** Encrypt a string using AES-256-GCM with environment/version-bound AAD. */
export async function encryptSecret(secret, options = {}) {
  if (typeof secret !== "string" && !(secret instanceof Uint8Array) && !Buffer.isBuffer(secret)) {
    throw authError("AUTH_SECRET_INVALID");
  }
  const plaintext = typeof secret === "string" ? textEncoder.encode(secret) : Buffer.from(secret);
  if (plaintext.length === 0) throw authError("AUTH_SECRET_EMPTY");
  const encryptionKey = resolveKey(options, "encryption");
  const hmacValue = own(options, ["hmacKey", "authHmacKey"]) ?? process.env.AUTH_HMAC_KEY;
  const hmacKey = hmacValue === undefined || hmacValue === ""
    ? null
    : keyBytes(hmacValue, "AUTH_HMAC_KEY", HMAC_KEY_BYTES);
  assertIndependent(hmacKey, encryptionKey);
  const identity = resolveEnvironment(options);
  const version = keyVersion(options);
  const iv = new Uint8Array(IV_BYTES);
  webcrypto.getRandomValues(iv);
  const key = await subtle.importKey("raw", encryptionKey, { name: "AES-GCM" }, false, ["encrypt"]);
  const encrypted = await subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(identity.environmentId, identity.siteId, version), tagLength: 128 },
    key,
    plaintext
  );
  const header = base64url(JSON.stringify({
    v: 1,
    k: version,
    e: base64url(identity.environmentId),
    s: base64url(identity.siteId),
    i: base64url(iv)
  }));
  return Buffer.from(`${ENVELOPE_PREFIX}.${header}.${base64url(encrypted)}`);
}

/** Decrypt an environment/version-bound AES-256-GCM envelope. */
export async function decryptSecret(ciphertext, options = {}) {
  const envelope = parseEnvelope(ciphertext);
  const identity = resolveEnvironment(options);
  if (envelope.environmentId !== identity.environmentId || envelope.siteId !== identity.siteId) {
    throw authError("AUTH_CIPHERTEXT_ENV_MISMATCH");
  }
  const version = keyVersion(options);
  if (envelope.header.k !== version) throw authError("AUTH_CIPHERTEXT_KEY_VERSION");
  const encryptionKey = resolveKey(options, "encryption");
  const hmacValue = own(options, ["hmacKey", "authHmacKey"]) ?? process.env.AUTH_HMAC_KEY;
  const hmacKey = hmacValue === undefined || hmacValue === ""
    ? null
    : keyBytes(hmacValue, "AUTH_HMAC_KEY", HMAC_KEY_BYTES);
  assertIndependent(hmacKey, encryptionKey);

  try {
    const key = await subtle.importKey("raw", encryptionKey, { name: "AES-GCM" }, false, ["decrypt"]);
    const plain = await subtle.decrypt(
      { name: "AES-GCM", iv: envelope.iv, additionalData: aad(identity.environmentId, identity.siteId, version), tagLength: 128 },
      key,
      envelope.encrypted
    );
    return textDecoder.decode(plain);
  } catch {
    throw authError("AUTH_CIPHERTEXT_INVALID");
  }
}
