import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AnalyticsData } from "../shared/types";
import { AnalyticsResults } from "./Analytics";
import { analyticsDate, durationLabel } from "./analytics-format";

const empty: AnalyticsData = {
  summary: { completedTickets: 0, averageCycleMs: null, medianCycleMs: null, averageLeadMs: null, activeTickets: 0, averageActiveAgeMs: null, averageWeeklyCloseRate: 0 },
  closeRatePeriod: { startedAt: "2026-09-03T00:00:00Z", endedAt: "2026-10-01T00:00:00Z", weeks: 4, completedTickets: 0 },
  priorityCounts: [{ priority: "urgent", backlog: 0, active: 0, total: 0 }], completedTickets: [], activeTickets: [],
};
const render = (data: AnalyticsData) => renderToStaticMarkup(<AnalyticsResults data={data} onTicketSelect={() => {}} />);

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

test("empty analytics explains delivery and close-rate metrics", () => {
  const html = render(empty);
  assert.match(html, /rolling 28 days/);
  assert.match(html, /Board entry → Done/);
  assert.match(html, /Tickets by priority/);
  assert.doesNotMatch(html, /sprint/i);
  assert.match(html, /Mark a ticket Done at its final workflow step/);
  assert.match(html, /No active tickets/);
  assert.match(html, /Ticket creation → Done/);
  assert.match(html, /tickets closed from Backlog are excluded/);
});

test("analytics shows delivered rows and priority counts without sprint filters", () => {
  const data: AnalyticsData = {
    ...empty,
    summary: { ...empty.summary, completedTickets: 2, averageCycleMs: 3_600_000, averageWeeklyCloseRate: 0.5 },
    priorityCounts: [{ priority: "urgent", backlog: 2, active: 3, total: 5 }],
    completedTickets: [{ id: "t1", number: "KANG-1", title: "Ship dashboard", createdAt: "2026-10-01T00:00:00Z", startedAt: "2026-10-01T01:00:00Z", closedAt: "2026-10-01T02:00:00Z", cycleMs: 3_600_000, leadMs: 7_200_000 }],
  };
  const html = render(data);
  assert.match(html, /Ship dashboard/);
  assert.match(html, /0.50 \/ week/);
  assert.match(html, /urgent<\/td><td>2<\/td><td>3<\/td><td>5<\/td>/);
  assert.match(html, /1h 0m/);
});

test("bounded detail tables explain that totals still cover every ticket", () => {
  const html = render({ ...empty, summary: { ...empty.summary, completedTickets: 501 } });
  assert.match(html, /500 latest delivered tickets/);
  assert.match(html, /summary metrics include all tickets/);
});
