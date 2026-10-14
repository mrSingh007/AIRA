import type { AnalyticsData, Project, Ticket } from "../shared/types.js";
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
export function projectAnalytics(state: State, projectId: string, timestamp = new Date().toISOString()): AnalyticsData {
  const tickets = state.tickets.filter(ticket => ticket.projectId === projectId);
  const completedTickets = tickets.filter(delivered).map(ticket => ({
    id: ticket.id, number: ticket.number, title: ticket.title,
    createdAt: ticket.createdAt, startedAt: ticket.startedAt ?? null, closedAt: ticket.closedAt!,
    cycleMs: duration(ticket.startedAt, ticket.closedAt!), leadMs: duration(ticket.createdAt, ticket.closedAt!),
  })).sort((a, b) => b.closedAt.localeCompare(a.closedAt));
  const activeTickets = tickets.filter(ticket => ticket.status === "active").map(ticket => ({
    id: ticket.id, number: ticket.number, title: ticket.title,
    startedAt: ticket.startedAt ?? null, ageMs: duration(ticket.startedAt, timestamp),
  })).sort((a, b) => (b.ageMs ?? -1) - (a.ageMs ?? -1));
  const cycles = completedTickets.map(ticket => ticket.cycleMs).filter((value): value is number => value !== null).sort((a, b) => a - b);
  const middle = Math.floor(cycles.length / 2);
  const closeRateWeeks = 4;
  const closeRateEnd = Date.parse(timestamp);
  const closeRateStart = closeRateEnd - closeRateWeeks * 7 * 86_400_000;
  const recentlyCompleted = completedTickets.filter(ticket => {
    const closed = Date.parse(ticket.closedAt);
    return closed >= closeRateStart && closed <= closeRateEnd;
  }).length;
  return {
    closeRatePeriod: { startedAt: new Date(closeRateStart).toISOString(), endedAt: timestamp, weeks: closeRateWeeks, completedTickets: recentlyCompleted },
    summary: {
      completedTickets: completedTickets.length, averageWeeklyCloseRate: recentlyCompleted / closeRateWeeks, averageCycleMs: average(cycles),
      medianCycleMs: cycles.length ? cycles.length % 2 ? cycles[middle] : (cycles[middle - 1] + cycles[middle]) / 2 : null,
      averageLeadMs: average(completedTickets.map(ticket => ticket.leadMs)),
      activeTickets: activeTickets.length, averageActiveAgeMs: average(activeTickets.map(ticket => ticket.ageMs)),
    },
    priorityCounts: (["urgent", "high", "medium", "low"] as const).map(priority => {
      const backlog = tickets.filter(ticket => ticket.priority === priority && ticket.status === "backlog").length;
      const active = tickets.filter(ticket => ticket.priority === priority && ticket.status === "active").length;
      return { priority, backlog, active, total: backlog + active };
    }),
    completedTickets: completedTickets.slice(0, 500), activeTickets: activeTickets.slice(0, 500),
  };
}
