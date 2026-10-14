import assert from "node:assert/strict";
import test from "node:test";
import type { Ticket } from "../shared/types";
import { doneTickets, sprintTickets } from "./board-tickets";
const ticket = (id: string, status: Ticket["status"], sprintId: string | null, closedAt: string | null): Ticket => ({
  id, projectId: "p", number: `TEAM-${id}`, title: "Ticket", description: "", priority: "medium",
  status, sprintId, stepId: "final", closedAt, createdAt: "", updatedAt: "", createdBy: "user", attachments: [], workflowSnapshot: null, pullRequests: [],
});
test("marking Done immediately moves an active-sprint ticket from the board to the archive", () => {
  const tickets = [ticket("1", "active", "sprint", null), ticket("2", "closed", null, "2026-10-11T10:00:00Z")];
  assert.deepEqual(sprintTickets(tickets, "sprint").map(t => t.id), ["1"]);
  assert.deepEqual(doneTickets(tickets).map(t => t.id), ["2"]);
  tickets[0] = { ...tickets[0], status: "closed", closedAt: "2026-10-13T10:00:00Z" };
  assert.deepEqual(sprintTickets(tickets, "sprint"), []);
  assert.deepEqual(doneTickets(tickets).map(t => t.id), ["1", "2"]);
  assert.deepEqual(tickets.map(t => t.id), ["1", "2"]);
});
