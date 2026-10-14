import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AnalyticsData } from "../shared/types";
import { AnalyticsResults } from "./Analytics";
import { analyticsDate, durationLabel } from "./analytics-format";

const empty: AnalyticsData = {
  summary: { completedTickets: 0, averageCycleMs: null, medianCycleMs: null, averageLeadMs: null, activeTickets: 0, averageActiveAgeMs: null },
  sprints: [], completedTickets: [], activeTickets: [],
};
const render = (data: AnalyticsData, sprintFilter = "all") => renderToStaticMarkup(<AnalyticsResults data={data} sprintFilter={sprintFilter} setSprintFilter={() => {}} onTicketSelect={() => {}} />);

test("duration formatting distinguishes unavailable, short, hourly, and daily times", () => {
  assert.equal(durationLabel(null), "—");
  assert.equal(durationLabel(Number.NaN), "—");
  assert.equal(durationLabel(-1), "—");
  assert.equal(durationLabel(0), "< 1 min");
  assert.equal(durationLabel(59_999), "< 1 min");
  assert.equal(durationLabel(90_000), "1 min");
  assert.equal(durationLabel(3_660_000), "1h 1m");
  assert.equal(durationLabel(90_000_000), "1d 1h");
  assert.equal(analyticsDate("invalid"), "—");
});

test("empty analytics explains how to produce sprint and delivery metrics", () => {
  const html = render(empty);
  assert.match(html, /Start a sprint/);
  assert.match(html, /Mark a ticket Done at its final workflow step/);
  assert.match(html, /No active tickets/);
  assert.match(html, /Ticket creation → Done/);
  assert.match(html, /tickets closed from Backlog are excluded/);
});

test("sprint filtering affects ticket rows while retaining project metric totals", () => {
  const data: AnalyticsData = {
    ...empty,
    summary: { ...empty.summary, completedTickets: 2, averageCycleMs: 3_600_000 },
    sprints: [{ id: "s1", name: "October delivery", description: "Goal: ship the board", startedAt: "2026-10-01T00:00:00Z", endedAt: "2026-10-03T00:00:00Z", completedAt: null, elapsedMs: 172_800_000, ticketCount: 2, completedTickets: 1, remainingTickets: 0, carriedTickets: 1 }],
    completedTickets: [
      { id: "t1", number: "KANG-1", title: "Ship dashboard", sprintId: "s1", createdAt: "2026-10-01T00:00:00Z", startedAt: "2026-10-01T01:00:00Z", closedAt: "2026-10-01T02:00:00Z", cycleMs: 3_600_000, leadMs: 7_200_000 },
      { id: "t2", number: "KANG-2", title: "Other delivery", sprintId: "s2", createdAt: "2026-10-01T00:00:00Z", startedAt: null, closedAt: "2026-10-01T02:00:00Z", cycleMs: null, leadMs: 7_200_000 },
    ],
  };
  const html = render(data, "s1");
  assert.match(html, /Ship dashboard/);
  assert.doesNotMatch(html, /Other delivery/);
  assert.match(html, /Goal: ship the board/);
  assert.match(html, /Incomplete/);
  assert.match(html, /1 carried in/);
  assert.match(html, /Project totals include all sprints/);
  assert.match(html, /1h 0m/);
  assert.match(html, /Delivered tickets<\/span><\/div><strong>2<\/strong>/);
});

test("bounded detail tables explain that totals still cover every ticket", () => {
  const html = render({ ...empty, summary: { ...empty.summary, completedTickets: 501 } });
  assert.match(html, /500 latest delivered tickets/);
  assert.match(html, /summary metrics include all tickets/);
});
