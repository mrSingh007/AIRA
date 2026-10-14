import type { AnalyticsData, Project, Sprint, Ticket } from "../shared/types.js";
import { hasProjectPermission } from "../shared/permissions.js";
import type { State } from "./state.js";

export function canViewAnalytics(project: Pick<Project, "roles" | "analyticsMemberIds" | "memberPermissions">, userId: string): boolean {
  return hasProjectPermission(project, userId, "analytics");
}

const delivered = (ticket: Ticket) => ticket.status === "closed" && !!ticket.closedAt && !!ticket.workflowSnapshot;
const duration = (start: string | null | undefined, end: string): number | null => {
  if (!start) return null;
  const elapsed = Date.parse(end) - Date.parse(start);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
};
const average = (values: Array<number | null>) => {
  const valid = values.filter((value): value is number => value !== null);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
};
const sprintTickets = (sprint: Sprint, tickets: Ticket[]) => {
  const ids = new Set(sprint.ticketIds ?? tickets.filter(ticket => ticket.sprintId === sprint.id).map(ticket => ticket.id));
  return tickets.filter(ticket => ids.has(ticket.id));
};

/** Admission is explicit so a carried ticket remains in the earlier sprint's scope. */
export function admitToSprint(sprint: Sprint, ticket: Ticket, timestamp: string, carried = false) {
  sprint.ticketIds ??= [];
  if (!sprint.ticketIds.includes(ticket.id)) sprint.ticketIds.push(ticket.id);
  if (carried) {
    sprint.carriedTicketIds ??= [];
    if (!sprint.carriedTicketIds.includes(ticket.id)) sprint.carriedTicketIds.push(ticket.id);
  }
  sprint.completedAt = null;
  if (!carried) ticket.startedAt ??= timestamp;
}

export function recordSprintCompletion(state: State, ticket: Ticket) {
  for (const sprint of state.sprints.filter(sprint => sprint.projectId === ticket.projectId)) {
    const included = sprintTickets(sprint, state.tickets.filter(item => item.projectId === ticket.projectId));
    if (included.some(item => item.id === ticket.id) && included.length && included.every(item => delivered(item) && (!sprint.endedAt || item.closedAt! <= sprint.endedAt))) {
      sprint.completedAt = included.map(item => item.closedAt!).sort().at(-1)!;
    }
  }
}

export function projectAnalytics(state: State, projectId: string, timestamp = new Date().toISOString()): AnalyticsData {
  const tickets = state.tickets.filter(ticket => ticket.projectId === projectId);
  const completedTickets = tickets.filter(delivered).map(ticket => ({
    id: ticket.id, number: ticket.number, title: ticket.title, sprintId: ticket.sprintId,
    createdAt: ticket.createdAt, startedAt: ticket.startedAt ?? null, closedAt: ticket.closedAt!,
    cycleMs: duration(ticket.startedAt, ticket.closedAt!), leadMs: duration(ticket.createdAt, ticket.closedAt!),
  })).sort((a, b) => b.closedAt.localeCompare(a.closedAt));
  const activeTickets = tickets.filter(ticket => ticket.status === "active").map(ticket => ({
    id: ticket.id, number: ticket.number, title: ticket.title, sprintId: ticket.sprintId,
    startedAt: ticket.startedAt ?? null, ageMs: duration(ticket.startedAt, timestamp),
  })).sort((a, b) => (b.ageMs ?? -1) - (a.ageMs ?? -1));
  const cycles = completedTickets.map(ticket => ticket.cycleMs).filter((value): value is number => value !== null).sort((a, b) => a - b);
  const middle = Math.floor(cycles.length / 2);
  return {
    summary: {
      completedTickets: completedTickets.length, averageCycleMs: average(cycles),
      medianCycleMs: cycles.length ? cycles.length % 2 ? cycles[middle] : (cycles[middle - 1] + cycles[middle]) / 2 : null,
      averageLeadMs: average(completedTickets.map(ticket => ticket.leadMs)),
      activeTickets: activeTickets.length, averageActiveAgeMs: average(activeTickets.map(ticket => ticket.ageMs)),
    },
    sprints: state.sprints.filter(sprint => sprint.projectId === projectId).map(sprint => {
      const included = sprintTickets(sprint, tickets);
      const complete = included.filter(ticket => delivered(ticket) && (!sprint.endedAt || ticket.closedAt! <= sprint.endedAt)).length;
      return {
        id: sprint.id, name: sprint.name, description: sprint.description ?? "", startedAt: sprint.startedAt,
        endedAt: sprint.endedAt, completedAt: sprint.completedAt ?? null,
        elapsedMs: duration(sprint.startedAt, sprint.completedAt ?? sprint.endedAt ?? timestamp),
        ticketCount: included.length, completedTickets: complete, remainingTickets: included.length - complete,
        carriedTickets: sprint.carriedTicketIds?.length ?? 0,
      };
    }).sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    completedTickets: completedTickets.slice(0, 500), activeTickets: activeTickets.slice(0, 500),
  };
}
