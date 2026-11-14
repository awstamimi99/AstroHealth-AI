// js/db/password.js
// Password hashing with PBKDF2-SHA256 via WebCrypto (crypto.subtle).
// Works in browsers (secure context: https or localhost) and Node 18+.
//
// ⚠️ DEMO ONLY — NOT REAL SECURITY. The hash lives in the browser's own
// database; anyone with the device can read or replace it. We hash anyway
// so students see the right pattern (salted, slow hash, never plain text).

export const PBKDF2_ITERATIONS = 100000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

/** Uint8Array → base64 text. */
function toBase64(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** base64 text → Uint8Array. */
function fromBase64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

async function derive(password, saltBytes, iterations) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(password)),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations },
    key,
    HASH_BITS
  );
  return new Uint8Array(bits);
}

/**
 * Hash a password with a fresh random salt.
 * @returns {Promise<{ passwordHash: string, salt: string }>} both base64
 */
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return { passwordHash: toBase64(hash), salt: toBase64(salt) };
}

/** true if `password` matches the stored hash + salt. */
export async function checkPassword(password, passwordHash, salt) {
  if (!passwordHash || !salt) return false;
  const actual = await derive(password, fromBase64(salt), PBKDF2_ITERATIONS);
  const expected = fromBase64(passwordHash);
  if (actual.length !== expected.length) return false;
  // Compare every byte (no early exit), the usual habit for secrets.
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}
