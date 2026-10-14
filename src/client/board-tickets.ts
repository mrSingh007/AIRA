import type { Ticket } from "../shared/types";

export function doneTickets(tickets: Ticket[]): Ticket[] {
  return tickets.filter(ticket => ticket.status === "closed")
    .sort((a, b) => (b.closedAt || "").localeCompare(a.closedAt || ""));
}
export function sprintTickets(tickets: Ticket[], sprintId?: string): Ticket[] {
  return tickets.filter(ticket => ticket.status === "active" && ticket.sprintId === sprintId);
}
