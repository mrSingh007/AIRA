import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeHistoryRecords, mergeLatestHistory, mergeOlderHistory } from "./ticket-history";

const records = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, index) => {
  const value = first + index;
  return { id: String(value).padStart(6, "0"), createdAt: new Date(value * 1000).toISOString(), status: "completed" };
});

test("75 new audit events reopen exhausted pagination and all intermediate records remain reachable", () => {
  const previous = records(1, 100);
  const latest = records(126, 175);
  const refreshed = mergeLatestHistory({ previous, latest, previousCursor: null,
    latestCursor: "before-126", pageOldest: latest[0], loadedHistory: true });
  assert.equal(refreshed.cursor, "before-126");
  assert.equal(refreshed.records.length, 150);
  const filled = mergeHistoryRecords(records(76, 125), refreshed.records);
  assert.deepEqual(filled.map(record => record.id), records(1, 175).map(record => record.id));
  // A subsequent top-page poll must not discard the reopened pagination progress.
  const polledAgain = mergeLatestHistory({ previous: refreshed.records, latest,
    previousCursor: refreshed.cursor, latestCursor: "before-126",
    pageOldest: latest[0], loadedHistory: true });
  assert.equal(polledAgain.cursor, "before-126");
});

test("historical run summaries cannot mask a gap after more than 50 new runs", () => {
  const previous = records(1, 100);
  const page = records(126, 175);
  const oldSummary = { ...previous[0], status: "cleanup complete" };
  const refreshed = mergeLatestHistory({ previous, latest: [oldSummary, ...page],
    previousCursor: "before-1", latestCursor: "before-126",
    pageOldest: page[0], loadedHistory: true });
  assert.equal(refreshed.cursor, "before-126");
  assert.equal(refreshed.records[0].status, "cleanup complete");
  assert.equal(new Set(refreshed.records.map(record => record.id)).size, refreshed.records.length);
});

test("overlapping top pages preserve older-pagination progress and update run metadata", () => {
  const previous = records(51, 100);
  const latest = records(91, 140);
  latest[0].status = "cleanup complete";
  const refreshed = mergeLatestHistory({ previous, latest,
    previousCursor: "before-51", latestCursor: "before-91",
    pageOldest: latest[0], loadedHistory: true });
  assert.equal(refreshed.cursor, "before-51");
  assert.equal(refreshed.records.find(record => record.id === latest[0].id)?.status, "cleanup complete");
  assert.deepEqual(refreshed.records.map(record => record.id), records(51, 140).map(record => record.id));
});

test("same-time pages use stable IDs to detect disjoint history", () => {
  const previous = records(1, 100).map(record => ({ ...record, createdAt: "2026-10-12T00:00:00.000Z" }));
  const latest = records(126, 175).map(record => ({ ...record, createdAt: previous[0].createdAt }));
  assert.equal(mergeLatestHistory({ previous, latest, previousCursor: null,
    latestCursor: "before-126", pageOldest: latest[0], loadedHistory: true }).cursor, "before-126");
});

test("a stale older page cannot overwrite a cursor reopened by a newer burst poll", () => {
  const oldHistory = records(51, 100);
  const latestPage = records(126, 175);
  const fresh = mergeLatestHistory({ previous: oldHistory, latest: latestPage,
    previousCursor: "before-51", latestCursor: "before-126",
    pageOldest: latestPage[0], loadedHistory: true });
  const stalePage = records(1, 50);
  stalePage.push({ ...latestPage[0], status: "old cleanup state" });
  const afterLateResponse = mergeOlderHistory({ previous: fresh.records, page: stalePage,
    previousCursor: fresh.cursor, requestedCursor: "before-51", pageCursor: null });
  assert.equal(afterLateResponse.cursor, "before-126");
  assert.equal(afterLateResponse.records.find(record => record.id === latestPage[0].id)?.status, "completed");
  assert.equal(afterLateResponse.records.length, 150);
  const gapFilled = mergeOlderHistory({ previous: afterLateResponse.records, page: records(76, 125),
    previousCursor: afterLateResponse.cursor, requestedCursor: "before-126", pageCursor: "before-76" });
  assert.equal(gapFilled.cursor, "before-76");
  assert.deepEqual(gapFilled.records.map(record => record.id), records(1, 175).map(record => record.id));
});
