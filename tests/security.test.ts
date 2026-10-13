import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Request, Response } from "express";
import { authenticate, clearSession, decrypt, encrypt, hashToken, initializeSecurity, issueSession, protectOrigin, redact } from "../src/server/security.js";
import { ApiError, emptyState } from "../src/server/state.js";

const secret = "unit-test-secret-with-at-least-32-characters";
function configure(t: TestContext, url = "http://localhost:3000") {
  const previous = { APP_SECRET: process.env.APP_SECRET, APP_URL: process.env.APP_URL, COOKIE_SECURE: process.env.COOKIE_SECURE };
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  process.env.APP_SECRET = secret;
  process.env.APP_URL = url;
  delete process.env.COOKIE_SECURE;
  initializeSecurity();
}
const request = (values: Partial<Request> = {}) => ({ secure: false, cookies: {}, ...values }) as Request;
const expiresAt = (offset: number) => new Date(Date.now() + offset).toISOString();

test("security initialization rejects weak secrets and non-origin app URLs", (t) => {
  configure(t);
  for (const value of ["", "short", "replace-this-secret-with-a-random-value", "change_me-abcdefghijklmnopqrstuvwxyz"]) {
    process.env.APP_SECRET = value;
    assert.throws(initializeSecurity, /APP_SECRET/);
  }
  process.env.APP_SECRET = secret;
  for (const value of ["", "ftp://localhost", "https://user:password@example.com", "https://example.com/path", "https://example.com/?x=1", "https://example.com/#hash"]) {
    process.env.APP_URL = value;
    assert.throws(initializeSecurity, /APP_URL/);
  }
});

test("encrypted credentials round-trip Unicode with unique nonces and reject tampering or another key", (t) => {
  configure(t);
  const value = "credential-🔑-秘密";
  const first = encrypt(value);
  assert.equal(decrypt(first), value);
  assert.notEqual(encrypt(value), first);
  assert.equal(encrypt(""), "");
  assert.equal(decrypt(""), "");
  const parts = first.split(".");
  const bytes = Buffer.from(parts[2], "base64");
  bytes[0] ^= 1;
  parts[2] = bytes.toString("base64");
  assert.throws(() => decrypt(parts.join(".")));
  process.env.APP_SECRET = "different-secret-with-at-least-32-characters";
  initializeSecurity();
  assert.throws(() => decrypt(first));
});

test("sessions retain at most ten active sessions per user and use secure cookie options", (t) => {
  configure(t, "https://aira.example.com");
  const state = emptyState();
  state.sessions = [
    { userId: "other", tokenHash: "other", expiresAt: expiresAt(60_000) },
    { userId: "user", tokenHash: "expired", expiresAt: expiresAt(-60_000) },
    ...Array.from({ length: 12 }, (_, index) => ({ userId: "user", tokenHash: String(index), expiresAt: expiresAt(60_000) })),
  ];
  let issuedToken = "";
  const res = { cookie(name: string, token: string, options: object) {
    assert.equal(name, "aira_session"); issuedToken = token;
    assert.deepEqual(options, { httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 604_800_000 });
  } } as Response;
  issueSession(state, request(), res, "user");
  assert.match(issuedToken, /^[a-f0-9]{64}$/);
  assert.equal(state.sessions.filter((session) => session.userId === "user").length, 10);
  assert.ok(state.sessions.some((session) => session.tokenHash === "other"));
  assert.ok(!state.sessions.some((session) => session.tokenHash === "expired" || session.tokenHash === "0"));
  assert.equal(state.sessions.at(-1)?.tokenHash, hashToken(issuedToken));
  assert.ok(!JSON.stringify(state.sessions).includes(issuedToken));
});

test("authentication requires a live session and blocks initial-password users except password change", (t) => {
  configure(t);
  const state = emptyState();
  const token = "a".repeat(64);
  const user = { id: "user", name: "User", email: "user@example.com", passwordHash: "hash", mustChangePassword: true };
  state.users.push(user);
  state.sessions.push({ userId: user.id, tokenHash: hashToken(token), expiresAt: expiresAt(60_000) });
  const req = request({ cookies: { aira_session: token } });
  assert.throws(() => authenticate(state, req), (error: unknown) => error instanceof ApiError && error.status === 403);
  assert.equal(authenticate(state, req, true), user);
  user.mustChangePassword = false;
  assert.equal(authenticate(state, req), user);
  for (const cookies of [{}, { aira_session: 123 }, { aira_session: "short" }, { aira_session: "b".repeat(64) }]) {
    assert.throws(() => authenticate(state, request({ cookies })), (error: unknown) => error instanceof ApiError && error.status === 401);
  }
  state.sessions[0].expiresAt = expiresAt(-60_000);
  assert.throws(() => authenticate(state, req), (error: unknown) => error instanceof ApiError && error.status === 401);
});

test("logout removes only the presented session and clears a matching cookie", (t) => {
  configure(t);
  const state = emptyState();
  const token = "a".repeat(64);
  state.sessions = [token, "b".repeat(64)].map((value) => ({ userId: "user", tokenHash: hashToken(value), expiresAt: expiresAt(60_000) }));
  const cleared: unknown[] = [];
  clearSession(state, request({ cookies: { aira_session: token } }), { clearCookie: (...args: unknown[]) => cleared.push(args) } as unknown as Response);
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].tokenHash, hashToken("b".repeat(64)));
  assert.deepEqual(cleared, [["aira_session", { httpOnly: true, sameSite: "lax", secure: false, path: "/" }]]);
});

test("origin protection permits safe reads and same-origin JSON writes but rejects cross-site writes", (t) => {
  configure(t);
  function check(method: string, json: boolean, headers: Record<string, string> = {}) {
    let outcome: unknown = "not called";
    protectOrigin({ method, is: () => json ? "application/json" : false, get: (name: string) => headers[name] } as unknown as Request, {} as Response, (error?: unknown) => { outcome = error; });
    return outcome;
  }
  for (const method of ["GET", "HEAD", "OPTIONS"]) assert.equal(check(method, false, { origin: "https://evil.example" }), undefined);
  assert.equal(check("POST", true), undefined);
  assert.equal(check("PATCH", true, { origin: "http://localhost:3000" }), undefined);
  assert.equal((check("POST", false) as ApiError).status, 415);
  assert.equal((check("DELETE", true, { origin: "https://evil.example" }) as ApiError).status, 403);
  assert.equal((check("POST", true, { "sec-fetch-site": "cross-site" }) as ApiError).status, 403);
});

test("redaction removes repeated literal secrets, GitHub tokens, and authorization credentials", () => {
  assert.equal(redact("a+b a+b ghp_example github_pat_example Authorization: Bearer abc token", ["", "a+b"]), "[REDACTED] [REDACTED] [REDACTED] [REDACTED] Authorization: Bearer [REDACTED] token");
  assert.equal(redact("safe diagnostic message"), "safe diagnostic message");
  assert.equal(redact("authorization=token secret"), "authorization=token [REDACTED]");
});
