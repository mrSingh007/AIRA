import assert from "node:assert/strict";
import test from "node:test";
import { canViewAnalytics, projectAnalytics } from "../src/server/analytics.js";
import { emptyState } from "../src/server/state.js";
import type { Project, Ticket } from "../src/shared/types.js";

const day = (value: number) => new Date(Date.UTC(2026, 0, value)).toISOString();
const ticket = (id: string, changes: Partial<Ticket> = {}): Ticket => ({ id, projectId: "project", number: id, title: id, description: "private", attachments: [], workflowSnapshot: null, priority: "medium", status: "active", stepId: "step", createdBy: "admin", createdAt: day(1), updatedAt: day(3), closedAt: null, startedAt: day(2), pullRequests: [], ...changes });

test("analytics access follows current project role and explicit member grants", () => {
  const project = { roles: { admin: "admin", member: "member" }, analyticsMemberIds: ["outsider"] } as unknown as Project;
  assert.equal(canViewAnalytics(project, "admin"), true);
  assert.equal(canViewAnalytics(project, "member"), false);
  assert.equal(canViewAnalytics(project, "outsider"), false);
  project.analyticsMemberIds!.push("member");
  assert.equal(canViewAnalytics(project, "member"), true);
  delete project.roles.member;
  assert.equal(canViewAnalytics(project, "member"), false);
  project.roles.admin = "member";
  assert.equal(canViewAnalytics(project, "admin"), false);
});

test("analytics measures delivery and excludes wont-do, invalid times, unrelated projects and private context", () => {
  const state = emptyState();
  state.tickets.push(ticket("done", { status: "closed", closedAt: day(5), workflowSnapshot: [] }), ticket("older", { status: "closed", closedAt: day(7), workflowSnapshot: [], startedAt: day(3) }), ticket("wont-do", { status: "closed", closedAt: day(5), startedAt: null }), ticket("active"), ticket("old-data", { startedAt: undefined }), ticket("foreign", { projectId: "other" }));
  const data = projectAnalytics(state, "project", day(8));
  const ms = 86400000;
  assert.equal(data.summary.completedTickets, 2);
  assert.equal(data.summary.averageCycleMs, 3.5 * ms);
  assert.equal(data.summary.medianCycleMs, 3.5 * ms);
  assert.equal(data.summary.averageLeadMs, 5 * ms);
  assert.equal(data.summary.activeTickets, 2);
  assert.equal(data.summary.averageActiveAgeMs, 6 * ms);
  assert.equal(data.activeTickets.find(item => item.id === "old-data")!.ageMs, null);
  assert.ok(!JSON.stringify(data).includes("private"));
  assert.equal(projectAnalytics(emptyState(), "project").summary.averageCycleMs, null);
});

test("priority counts distinguish backlog and board and exclude done and other projects", () => {
  const state = emptyState();
  state.tickets.push(ticket("backlog", { status: "backlog", priority: "urgent" }), ticket("active", { priority: "urgent" }), ticket("done", { status: "closed", priority: "urgent" }), ticket("foreign", { projectId: "other", priority: "high" }));
  const data = projectAnalytics(state, "project", day(30));
  assert.deepEqual(data.priorityCounts.find(row => row.priority === "urgent"), { priority: "urgent", backlog: 1, active: 1, total: 2 });
  assert.deepEqual(data.priorityCounts.find(row => row.priority === "high"), { priority: "high", backlog: 0, active: 0, total: 0 });
  assert.equal(data.summary.activeTickets, 1);
});

test("close rate uses four rolling weeks and counts all deliveries before detail caps", () => {
  const state = emptyState();
  state.tickets.push(ticket("outside", { status: "closed", closedAt: day(1), workflowSnapshot: [] }), ticket("boundary", { status: "closed", closedAt: day(2), workflowSnapshot: [] }), ticket("future", { status: "closed", closedAt: day(31), workflowSnapshot: [] }), ticket("wont-do", { status: "closed", closedAt: day(20), workflowSnapshot: null }));
  for (let index = 0; index < 510; index++) state.tickets.push(ticket(`done-${index}`, { status: "closed", closedAt: day(20), workflowSnapshot: [] }));
  const data = projectAnalytics(state, "project", day(30));
  assert.equal(data.completedTickets.length, 500);
  assert.equal(data.summary.completedTickets, 513);
  assert.equal(data.closeRatePeriod.startedAt, day(2));
  assert.equal(data.closeRatePeriod.completedTickets, 511);
  assert.equal(data.summary.averageWeeklyCloseRate, 511 / 4);
});

test("invalid and negative elapsed times do not enter timing averages", () => {
  const state = emptyState();
  state.tickets.push(ticket("negative", { status: "closed", startedAt: day(8), closedAt: day(7), workflowSnapshot: [] }), ticket("invalid", { startedAt: "invalid" }));
  const data = projectAnalytics(state, "project", day(10));
  assert.equal(data.summary.averageCycleMs, null);
  assert.equal(data.summary.averageActiveAgeMs, null);
});
