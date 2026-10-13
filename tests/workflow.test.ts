import assert from "node:assert/strict";
import test from "node:test";
import { implementationReady, requiredApprovalCount } from "../src/shared/workflow.js";
import type { Run, Step, Ticket, TicketPullRequest } from "../src/shared/types.js";

const step: Step = { id: "step", kind: "implement", name: "Implement", instructions: "", model: "", requiredApprovals: 2, approverIds: ["user"], includePriorArtifacts: false, filename: "implementation.md" };
const ticket = (pullRequests: TicketPullRequest[] = []): Ticket => ({ id: "ticket", projectId: "project", number: "AIRA-1", title: "Task", description: "", attachments: [], workflowSnapshot: null, priority: "medium", status: "active", stepId: step.id, sprintId: null, createdBy: "user", createdAt: "", updatedAt: "", closedAt: null, pullRequests });
const run = (changes: Partial<Run> = {}): Run => ({ id: "run", projectId: "project", ticketId: "ticket", stepId: step.id, threadId: null, kind: "implement", status: "completed", cleanupStatus: "complete", logSealed: true, error: null, createdAt: "", startedAt: "", finishedAt: "", ...changes });
const pr: TicketPullRequest = { stepId: step.id, runId: "run", number: 1, url: "https://github.com/owner/repo/pull/1" };

test("implementation requires a completed latest implementation and its matching pull request", () => {
  assert.equal(implementationReady(ticket([pr]), step, []), false);
  assert.equal(implementationReady(ticket(), step, [run()]), false);
  assert.equal(implementationReady(ticket([pr]), step, [run()]), true);
  for (const status of ["pending", "running", "failed"] as const) {
    assert.equal(implementationReady(ticket([pr]), step, [run({ status })]), false);
    assert.equal(implementationReady(ticket([pr]), step, [run(), run({ id: "newer", status })]), false);
  }
  for (const changes of [{ stepId: "other" }, { runId: "older" }, { number: 0 }, { url: "" }]) {
    assert.equal(implementationReady(ticket([{ ...pr, ...changes }]), step, [run()]), false);
  }
});

test("completed no-change implementations need no PR and unrelated runs cannot override readiness", () => {
  const runs = [run({ noChanges: true }), run({ id: "chat", kind: "chat", status: "failed" }), run({ id: "other-ticket", ticketId: "other", status: "failed" }), run({ id: "other-step", stepId: "other", status: "failed" })];
  assert.equal(implementationReady(ticket(), step, runs), true);
  assert.equal(implementationReady(ticket(), step, [run({ noChanges: true, status: "failed" })]), false);
  for (const kind of ["definition", "manual", "sprint"] as const) assert.equal(implementationReady(ticket(), { ...step, kind }, runs), false);
});

test("approval requirements use the configured count without deriving it from approver assignments", () => {
  assert.equal(requiredApprovalCount(step), 2);
  assert.equal(requiredApprovalCount({ ...step, requiredApprovals: 0, approverIds: ["one", "two"] }), 0);
  assert.equal(requiredApprovalCount({ ...step, requiredApprovals: 5, approverIds: [] }), 5);
});
