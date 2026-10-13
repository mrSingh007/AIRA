import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/server/db.js";
import {
  flushRunLogs, logBufferUsage, openRunLog, LOG_TAIL_LIMIT,
  TOTAL_LOG_BUFFER_LIMIT,
} from "../src/server/run-logs.js";

test("outage buffers stay bounded across 64 runs and preserve unacknowledged append batches", async (t) => {
  const rows = new Map<string, { tail: string; last_sequence: number; sealed: boolean; version: number }>();
  const failedBatches: string[] = [];
  const acknowledgedBatches: string[] = [];
  let unavailable = true;
  let loseAcknowledgement = false;
  t.mock.method(pool, "query", async (sql: string, values: any[] = []) => {
    if (sql.startsWith("INSERT")) {
      if (!rows.has(values[0])) rows.set(values[0], { tail: "", last_sequence: 0, sealed: false, version: 0 });
    } else if (sql.startsWith("SELECT")) {
      return { rows: [rows.get(values[0])], rowCount: 1 };
    } else if (sql.startsWith("UPDATE aira_run_logs AS l")) {
      if (unavailable) { failedBatches.push(values[0]); throw new Error("Database unavailable"); }
      acknowledgedBatches.push(values[0]);
      for (const record of JSON.parse(values[0])) {
        const row = rows.get(record.id)!;
        if (record.sequence > row.last_sequence && !row.sealed) {
          row.tail = (row.tail + record.text).slice(-LOG_TAIL_LIMIT);
          row.last_sequence = record.sequence;
          row.version++;
        }
      }
      if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error("Append committed but acknowledgement lost"); }
    } else if (sql.includes("SET sealed=true")) {
      const row = rows.get(values[0])!;
      row.sealed = true;
      row.version++;
    } else throw new Error(`Unexpected SQL: ${sql}`);
    return { rows: [], rowCount: 1 };
  });
  const writers = await Promise.all(Array.from({ length: 64 }, (_, i) => openRunLog(`bounded-${i}`, ["test-secret"])));
  try {
    for (let iteration = 0; iteration < 15; iteration++) {
      for (let i = 0; i < writers.length; i++) await writers[i].write(`${iteration}:test-secret:${"output".repeat(5000)}`);
      assert.ok(logBufferUsage().characters <= TOTAL_LOG_BUFFER_LIMIT);
    }
    await assert.rejects(flushRunLogs(), /Database unavailable/);
    assert.equal(failedBatches.length, 1);
    // Additional output cannot replace the immutable, failed database batch.
    for (const writer of writers) await writer.write("last diagnostic test-secret");
    assert.ok(logBufferUsage().characters <= TOTAL_LOG_BUFFER_LIMIT);
    unavailable = false;
    await flushRunLogs();
    assert.equal(acknowledgedBatches[0], failedBatches[0]);
    for (const writer of writers) await writer.seal();
    for (const row of rows.values()) {
      assert.ok(row.tail.length <= LOG_TAIL_LIMIT);
      assert.ok(!row.tail.includes("test-secret"));
    }
    assert.ok([...rows.values()].some((row) => row.tail.includes("output omitted")));
    assert.ok([...rows.values()].some((row) => row.tail.includes("last diagnostic [REDACTED]")));
    assert.deepEqual(logBufferUsage(), { characters: 0, streams: 0 });
    const busyWriters = await Promise.all(Array.from({length:6},(_,index)=>openRunLog(`busy-${index}`)));
    for (const writer of busyWriters) await writer.write("busy output " + "x".repeat(250_000));
    // The first pair keeps emitting at the flush size. Every peer must still
    // receive a database append within one complete rotation.
    for (let round=0;round<3;round++) {
      await flushRunLogs();
      for (const writer of busyWriters.slice(0,2)) await writer.write("continuous output " + "y".repeat(250_000));
    }
    for (let index=0;index<busyWriters.length;index++) assert.ok(rows.get(`busy-${index}`)!.version>0, `Run ${index} must not be starved by earlier noisy runs`);
    for (const writer of busyWriters) await writer.seal();
    const idleWriter = await openRunLog("earlier-idle-run");
    const lostAckWriter = await openRunLog("lost-acknowledgement");
    await lostAckWriter.write("exactly-once-finalization-diagnostic");
    loseAcknowledgement = true;
    await assert.rejects(lostAckWriter.flush(), /acknowledgement lost/);
    const lostBatch = acknowledgedBatches.at(-1);
    await idleWriter.write("new output must not displace an unacknowledged batch");
    const committed = rows.get("lost-acknowledgement")!;
    const committedVersion = committed.version;
    await lostAckWriter.flush();
    assert.equal(acknowledgedBatches.at(-1), lostBatch);
    assert.equal(committed.tail.match(/exactly-once-finalization-diagnostic/g)?.length, 1);
    assert.equal(committed.version, committedVersion);
    await lostAckWriter.seal();
    await idleWriter.seal();
    const oversizedWriter = await openRunLog("oversized-line");
    await oversizedWriter.write("large-line:" + "x".repeat(900_000));
    assert.ok(logBufferUsage().characters <= TOTAL_LOG_BUFFER_LIMIT);
    await oversizedWriter.seal();
    assert.ok(rows.get("oversized-line")!.tail.includes("output omitted"), "Truncated single lines must retain an omission diagnostic in the stored tail");
    assert.deepEqual(logBufferUsage(), { characters: 0, streams: 0 });
  } finally {
    unavailable = false;
    for (const writer of writers) await writer.seal();
    await pool.end();
  }
});
