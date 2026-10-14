import assert from "node:assert/strict";
import test from "node:test";
import type { Ticket } from "../shared/types";
import { doneTickets, boardTickets } from "./board-tickets";
const ticket = (id: string, status: Ticket["status"], closedAt: string | null): Ticket => ({
  id, projectId: "p", number: `TEAM-${id}`, title: "Ticket", description: "", priority: "medium",
  status, stepId: "final", closedAt, createdAt: "", updatedAt: "", createdBy: "user", attachments: [], workflowSnapshot: null, pullRequests: [],
});
test("marking Done immediately moves a board ticket from the board to the archive", () => {
  const tickets = [ticket("1", "active", null), ticket("2", "closed", "2026-10-11T10:00:00Z")];
  assert.deepEqual(boardTickets(tickets).map(t => t.id), ["1"]);
  assert.deepEqual(doneTickets(tickets).map(t => t.id), ["2"]);
  tickets[0] = { ...tickets[0], status: "closed", closedAt: "2026-10-13T10:00:00Z" };
  assert.deepEqual(boardTickets(tickets), []);
  assert.deepEqual(doneTickets(tickets).map(t => t.id), ["1", "2"]);
  assert.deepEqual(tickets.map(t => t.id), ["1", "2"]);
});

test("the board contains active tickets without requiring scheduling metadata", () => {
  const tickets = [ticket("1", "backlog", null), ticket("2", "active", null), ticket("3", "closed", "2026-10-13T10:00:00Z")];
  assert.deepEqual(boardTickets(tickets).map(t => t.id), ["2"]);
});
