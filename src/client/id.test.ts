import assert from "node:assert/strict";
import test from "node:test";
import { randomId } from "./id.js";

test("client IDs use getRandomValues and encode UUID version and variant without randomUUID", (t) => {
  // HTTP LAN pages do not always expose crypto.randomUUID.
  t.mock.method(globalThis.crypto, "getRandomValues", (bytes: Uint8Array) => {
    assert.equal(bytes.length, 16);
    bytes.fill(0xff);
    return bytes;
  });
  t.mock.method(globalThis.crypto, "randomUUID", () => { throw new Error("Unavailable on HTTP LAN"); });
  assert.equal(randomId(), "ffffffff-ffff-4fff-bfff-ffffffffffff");
});

test("client IDs pad bytes with leading zeroes and preserve the correct UUID variant", (t) => {
  t.mock.method(globalThis.crypto, "getRandomValues", (bytes: Uint8Array) => {
    bytes.set(Array.from({ length: 16 }, (_, index) => index));
    return bytes;
  });
  assert.equal(randomId(), "00010203-0405-4607-8809-0a0b0c0d0e0f");
});
