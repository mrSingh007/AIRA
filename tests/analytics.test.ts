import assert from "node:assert/strict";
import test from "node:test";
import { admitToSprint, canViewAnalytics, projectAnalytics, recordSprintCompletion } from "../src/server/analytics.js";
import { emptyState } from "../src/server/state.js";
import type { Project, Sprint, Ticket } from "../src/shared/types.js";

const day = (value: number) => new Date(Date.UTC(2026, 0, value)).toISOString();
const ticket = (id: string, changes: Partial<Ticket> = {}): Ticket => ({ id, projectId: "project", number: id, title: id, description: "private", attachments: [], workflowSnapshot: null, priority: "medium", status: "active", stepId: "step", sprintId: "sprint", createdBy: "admin", createdAt: day(1), updatedAt: day(3), closedAt: null, startedAt: day(2), pullRequests: [], ...changes });
const sprint = (id: string): Sprint => ({ id, projectId: "project", name: id, startedAt: day(2), endedAt: null, ticketIds: [], completedAt: null });

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

test("sprint admission preserves cycle across carry, restarts after backlog, and completes tracked scope", () => {
  const state = emptyState();
  const first = sprint("first"), second = sprint("second"), empty = sprint("empty");
  const one = ticket("one", { startedAt: null }), two = ticket("two");
  state.sprints.push(first, second, empty); state.tickets.push(one, two);
  admitToSprint(first, one, day(2)); admitToSprint(first, two, day(2));
  admitToSprint(second, one, day(4), true);
  assert.equal(one.startedAt, day(2));
  assert.deepEqual(first.ticketIds, ["one", "two"]);
  assert.deepEqual(second.carriedTicketIds, ["one"]);
  one.status = "closed"; one.closedAt = day(5); one.workflowSnapshot = [];
  recordSprintCompletion(state, one);
  assert.equal(first.completedAt, null);
  assert.equal(second.completedAt, day(5));
  assert.equal(empty.completedAt, null);
  two.status = "closed"; two.closedAt = day(6); two.workflowSnapshot = [];
  recordSprintCompletion(state, two);
  assert.equal(first.completedAt, day(6));
  const newTicket = ticket("new", { startedAt: null });
  admitToSprint(second, newTicket, day(7));
  assert.equal(second.completedAt, null);
  assert.equal(newTicket.startedAt, day(7));
  newTicket.startedAt = null;
  admitToSprint(second, newTicket, day(9));
  assert.equal(newTicket.startedAt, day(9));
  assert.deepEqual(second.ticketIds, ["one", "new"]);
  const result = projectAnalytics(state, "project", day(10));
  assert.equal(result.sprints.find(item => item.id === "first")!.elapsedMs, 4 * 86400000);
  assert.equal(result.sprints.find(item => item.id === "second")!.carriedTickets, 1);
});

test("ended sprints exclude work delivered after carry and detail caps preserve complete aggregates", () => {
  const state = emptyState();
  const first = sprint("first"); first.endedAt = day(3); first.ticketIds = ["later"];
  const later = ticket("later", { status: "closed", closedAt: day(5), workflowSnapshot: [] });
  state.sprints.push(first); state.tickets.push(later);
  recordSprintCompletion(state, later);
  assert.equal(first.completedAt, null);
  const row = projectAnalytics(state, "project", day(8)).sprints[0];
  assert.equal(row.completedTickets, 0);
  assert.equal(row.remainingTickets, 1);
  assert.equal(row.elapsedMs, 86400000);
  const unknown = ticket("unknown", { startedAt: undefined });
  admitToSprint(sprint("next"), unknown, day(8), true);
  assert.equal(unknown.startedAt, undefined);
  for (let index = 0; index < 510; index++) state.tickets.push(ticket(`done-${index}`, { status: "closed", closedAt: day(5), workflowSnapshot: [] }));
  const data = projectAnalytics(state, "project", day(8));
  assert.equal(data.completedTickets.length, 500);
  assert.equal(data.summary.completedTickets, 511);
});
