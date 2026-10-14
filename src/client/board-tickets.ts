import type { Ticket } from "../shared/types";

export function doneTickets(tickets: Ticket[]): Ticket[] {
  return tickets.filter(ticket => ticket.status === "closed")
    .sort((a, b) => (b.closedAt || "").localeCompare(a.closedAt || ""));
}
export function boardTickets(tickets: Ticket[]): Ticket[] {
  return tickets.filter(ticket => ticket.status === "active");
}
