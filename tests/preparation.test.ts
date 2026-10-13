import assert from "node:assert/strict";
import test from "node:test";
import {
  abortableDelay, credentialScope, FairPreparationGate, providerCooldown,
  recordProviderCooldown, RetryablePreparationError, retryDelay, throttledResponse,
} from "../src/server/preparation.js";

test("preparation capacity validation and already cancelled admission cannot consume slots", () => {
  for (const capacity of [0, -1, 1.5, Infinity, NaN]) assert.throws(() => new FairPreparationGate(capacity), /Invalid preparation capacity/);
  const gate = new FairPreparationGate(2);
  const controller = new AbortController();
  controller.abort(new Error("Already cancelled"));
  assert.throws(() => gate.acquire("project", controller.signal), /Already cancelled/);
  assert.equal(gate.occupancy, 0);
  assert.equal(gate.waiting, 0);
});

test("cancelling the last queued project removes it without blocking subsequent admissions", async () => {
  const gate = new FairPreparationGate(1);
  const release = await gate.acquire("active");
  const controller = new AbortController();
  const cancelled = gate.acquire("cancelled", controller.signal);
  const rejection = assert.rejects(cancelled, /Cancelled queued project/);
  controller.abort(new Error("Cancelled queued project"));
  await rejection;
  const next = gate.acquire("next");
  assert.equal(gate.waiting, 1);
  release();
  const releaseNext = await next;
  assert.equal(gate.occupancy, 1);
  assert.equal(gate.waiting, 0);
  releaseNext();
  assert.equal(gate.occupancy, 0);
});

test("provider cooldown preserves the longest deadline and expires independently by credential scope", (t) => {
  let time = 1_000_000;
  t.mock.method(Date, "now", () => time);
  const scope = credentialScope("github", "cooldown-test-key");
  const other = credentialScope("github", "different-cooldown-key");
  assert.ok(!scope.includes("cooldown-test-key"));
  assert.notEqual(scope, credentialScope("e2b", "cooldown-test-key"));
  recordProviderCooldown(new RetryablePreparationError("Wait", scope, 10_000));
  time += 2_000;
  recordProviderCooldown(new RetryablePreparationError("Shorter wait", scope, 1_000));
  assert.equal(providerCooldown(scope), 8_000);
  assert.equal(providerCooldown(other), 0);
  time += 8_000;
  assert.equal(providerCooldown(scope), 0);
  assert.equal(providerCooldown(scope), 0);
});

test("GitHub rate limit dates and reset headers are respected while permission errors stay terminal", (t) => {
  const time = Date.parse("2026-10-13T10:00:00Z");
  t.mock.method(Date, "now", () => time);
  const cases: Array<{ status: number; headers: Record<string, string>; delay: number | undefined }> = [
    { status: 403, headers: {}, delay: undefined },
    { status: 401, headers: { "retry-after": "60" }, delay: undefined },
    { status: 503, headers: { "retry-after": "60" }, delay: undefined },
    { status: 403, headers: { "retry-after": "Tue, 13 Oct 2026 10:00:05 GMT" }, delay: 5_000 },
    { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(time / 1000 + 7) }, delay: 7_000 },
    { status: 429, headers: { "retry-after": "invalid" }, delay: 30_000 },
    { status: 429, headers: { "retry-after": "0" }, delay: 30_000 },
  ];
  for (const [index, fixture] of cases.entries()) {
    const scope = `throttle-edge-${index}`;
    const result = throttledResponse(new Response(null, { status: fixture.status, headers: fixture.headers }), scope);
    assert.equal(result?.retryAfterMs, fixture.delay);
    assert.equal(providerCooldown(scope), fixture.delay ?? 0);
  }
  // Advance to clear the test's recorded deadlines.
  t.mock.method(Date, "now", () => time + 60_000);
  for (let index = 0; index < cases.length; index++) assert.equal(providerCooldown(`throttle-edge-${index}`), 0);
});

test("retry delays honor provider minima, add jitter and stay within the five minute cap", () => {
  assert.equal(retryDelay(0, 0, () => 0), 5_000);
  assert.equal(retryDelay(2, 0, () => 0.5), 21_000);
  assert.equal(retryDelay(1, 60_000, () => 0.5), 61_000);
  assert.equal(retryDelay(100, 0, () => 0.99), 300_000);
  assert.equal(retryDelay(1, 900_000, () => 0), 300_000);
});

test("abortable delay completes normally and rejects cancellation without waiting for the timer", async () => {
  await abortableDelay(0);
  const controller = new AbortController();
  const reason = new Error("Delay cancelled");
  const delayed = abortableDelay(60_000, controller.signal);
  const rejection = assert.rejects(delayed, error => error === reason);
  controller.abort(reason);
  await rejection;
  await assert.rejects(abortableDelay(0, controller.signal), error => error === reason);
});
