import assert from "node:assert/strict";
import test from "node:test";
import { readSidebarCollapsed, saveSidebarCollapsed } from "./sidebar-state";

test("sidebar preference restores and updates tab-session storage", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  assert.equal(readSidebarCollapsed(storage), false);
  saveSidebarCollapsed(true, storage);
  assert.equal(readSidebarCollapsed(storage), true);
  saveSidebarCollapsed(false, storage);
  assert.equal(readSidebarCollapsed(storage), false);
  assert.equal(readSidebarCollapsed({getItem: () => "unexpected"}), false);
});
test("unavailable session storage does not prevent sidebar use", () => {
  assert.equal(readSidebarCollapsed({getItem: () => { throw new Error("Blocked storage"); }}), false);
  assert.doesNotThrow(() => saveSidebarCollapsed(true, {setItem: () => { throw new Error("Blocked storage"); }}));
});
