import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunLogData } from "../shared/types";
import { pollRunLogs } from "./run-logs";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const run = { id: "run-a", status: "completed" as const, cleanupStatus: "pending" as const, logSealed: false };

test("closing an expanded stream aborts and ignores a late private log response", async () => {
  let resolve!: (value: RunLogData) => void;
  let signal!: AbortSignal;
  const updates: RunLogData[] = [];
  let scheduled = 0;
  const stop = pollRunLogs({
    run, version: null, receive: (data) => updates.push(data), fail: (error) => assert.fail(String(error)),
    fetchLogs: (_version, requestSignal) => { signal = requestSignal; return new Promise((done) => { resolve = done; }); },
    schedule: () => { scheduled++; return () => {}; },
  });
  stop();
  resolve({ tail: "private logs from the previously selected ticket", version: 3, unchanged: false, sealed: false });
  await tick();
  assert.equal(signal.aborted, true);
  assert.deepEqual(updates, []);
  assert.equal(scheduled, 0);
});

test("completed executions continue polling cleanup diagnostics with their last version", async () => {
  const versions: Array<number | null> = [];
  const updates: RunLogData[] = [];
  const callbacks: Array<() => void> = [];
  const stop = pollRunLogs({
    run, version: null, receive: (data) => updates.push(data), fail: (error) => assert.fail(String(error)),
    fetchLogs: async (version) => {
      versions.push(version);
      return version === null
        ? { tail: "cleanup retry", version: 4, unchanged: false, sealed: false }
        : { version: 4, unchanged: true, sealed: false };
    },
    schedule: (callback) => { callbacks.push(callback); return () => {}; },
  });
  await tick();
  callbacks.shift()!();
  await tick();
  stop();
  assert.deepEqual(versions, [null, 4]);
  assert.equal(updates[1].unchanged, true);
  assert.equal(callbacks.length, 1);
});

test("settled sealed executions get one final refresh and stop", async () => {
  let fetched = 0;
  let scheduled = 0;
  const updates: RunLogData[] = [];
  const stop = pollRunLogs({
    run: { ...run, cleanupStatus: "complete", logSealed: true },
    version: 4, receive: (data) => updates.push(data), fail: (error) => assert.fail(String(error)),
    fetchLogs: async () => { fetched++; return { tail: "cleanup complete", version: 5, unchanged: false, sealed: true }; },
    schedule: () => { scheduled++; return () => {}; },
  });
  await tick();
  stop();
  assert.equal(fetched, 1);
  assert.equal(scheduled, 0);
  assert.equal(updates[0].tail, "cleanup complete");
});

test("a transient log fetch failure retries without losing the known version", async () => {
  const callbacks: Array<() => void> = [];
  const versions: Array<number | null> = [];
  let failures = 0;
  const stop = pollRunLogs({
    run, version: 8, receive: () => {}, fail: () => { failures++; },
    fetchLogs: async (version) => {
      versions.push(version);
      if (versions.length === 1) throw new Error("temporarily unavailable");
      return { version: 8, unchanged: true, sealed: false };
    },
    schedule: (callback) => { callbacks.push(callback); return () => {}; },
  });
  await tick();
  callbacks.shift()!();
  await tick();
  stop();
  assert.deepEqual(versions, [8, 8]);
  assert.equal(failures, 1);
});
