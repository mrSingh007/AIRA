import type { HistoryBoundary } from "../shared/types";

function compare(a: HistoryBoundary, b: HistoryBoundary) {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

export function mergeHistoryRecords<T extends HistoryBoundary>(older: T[], newer: T[]): T[] {
  return [...new Map([...older, ...newer].map((record) => [record.id, record])).values()].sort(compare);
}

export function mergeLatestHistory<T extends HistoryBoundary>(options: {
  previous: T[];
  latest: T[];
  previousCursor: string | null;
  latestCursor: string | null;
  pageOldest: HistoryBoundary | null;
  loadedHistory: boolean;
}) {
  const previousNewest = [...options.previous].sort(compare).at(-1);
  // A disjoint latest page can hide records added since the previous poll.
  // Reopen pagination at its boundary, even after the older history was exhausted.
  const hasGap = !!previousNewest && !!options.pageOldest && compare(options.pageOldest, previousNewest) > 0;
  return {
    records: mergeHistoryRecords(options.previous, options.latest),
    cursor: !options.loadedHistory || hasGap ? options.latestCursor : options.previousCursor,
  };
}

export function mergeOlderHistory<T extends HistoryBoundary>(options: {
  previous: T[];
  page: T[];
  previousCursor: string | null;
  requestedCursor: string;
  pageCursor: string | null;
}) {
  return {
    records: mergeHistoryRecords(options.page, options.previous),
    // A fresh top-page poll can reopen pagination while this older request is
    // in flight. Its new cursor must remain available to fill that recent gap.
    cursor: options.previousCursor === options.requestedCursor ? options.pageCursor : options.previousCursor,
  };
}
