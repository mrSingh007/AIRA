import { useEffect, useRef, useState } from "react";
import { BarChart3, CheckCheck, Clock3, Timer } from "lucide-react";
import type { AnalyticsData } from "../shared/types";
import { api, ApiError, errorMessage } from "./api";
import { Spinner } from "./ui";
import { analyticsDate, durationLabel } from "./analytics-format";

export function Analytics({ projectId, onTicketSelect, onAccessDenied }: {
  projectId: string;
  onTicketSelect: (ticketId: string) => void;
  onAccessDenied: () => void;
}) {
  const [result, setResult] = useState<{ projectId: string; data: AnalyticsData } | null>(null);
  const [error, setError] = useState("");
  const denied = useRef(onAccessDenied);
  denied.current = onAccessDenied;
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    setResult(null);
    setError("");
    async function load() {
      let schedule = true;
      try {
        const data = await api<AnalyticsData>(`/projects/${projectId}/analytics`, "GET", undefined, controller.signal);
        if (!disposed) { setResult({ projectId, data }); setError(""); }
      } catch (failure) {
        if (disposed) return;
        if (failure instanceof ApiError && [401, 403, 404].includes(failure.status)) {
          setResult(null);
          schedule = false;
          denied.current();
        } else setError(errorMessage(failure));
      } finally {
        if (!disposed && schedule) timer = setTimeout(() => void load(), 15_000);
      }
    }
    void load();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  }, [projectId]);
  const data = result?.projectId === projectId ? result.data : null;
  return <section className="analytics-page">
    <header className="analytics-header"><span className="analytics-heading-icon"><BarChart3 size={23} /></span><div><h1>Analytics</h1><p>Understand delivery time, ticket close rate, and work still in flight.</p></div></header>
    {error && <div className="analytics-error" role="alert">{error}</div>}
    {!data ? (!error && <div className="analytics-loading"><Spinner label="Loading analytics" /></div>) : <AnalyticsResults data={data} onTicketSelect={onTicketSelect} />}
  </section>;
}

export function AnalyticsResults({ data, onTicketSelect }: {
  data: AnalyticsData;
  onTicketSelect: (id: string) => void;
}) {
  const completed = data.completedTickets;
  const active = data.activeTickets;
  const summary = data.summary;
  return <>
    <div className="analytics-metrics">
      <Metric icon={<CheckCheck size={19} />} label="Delivered tickets" value={String(summary.completedTickets)} detail="Completed through the workflow" />
      <Metric icon={<Timer size={19} />} label="Average completion time" value={durationLabel(summary.averageCycleMs)} detail={`Board entry → Done · median ${durationLabel(summary.medianCycleMs)}`} />
      <Metric icon={<Clock3 size={19} />} label="Average lead time" value={durationLabel(summary.averageLeadMs)} detail="Ticket creation → Done" />
      <Metric icon={<BarChart3 size={19} />} label="Active tickets" value={String(summary.activeTickets)} detail={`Average time in flight ${durationLabel(summary.averageActiveAgeMs)}`} />
      <Metric icon={<CheckCheck size={19} />} label="Average close rate" value={`${summary.averageWeeklyCloseRate.toFixed(2)} / week`} detail={`${data.closeRatePeriod.completedTickets} delivered over the last ${data.closeRatePeriod.weeks} weeks`} />
    </div>
    <p className="analytics-context">Close rate covers {analyticsDate(data.closeRatePeriod.startedAt)} to {analyticsDate(data.closeRatePeriod.endedAt)} (rolling 28 days). Project totals include all tickets. Times are elapsed calendar time, including waiting; tickets closed from Backlog are excluded from delivery metrics. Missing historical start times appear as —.</p>
    <section className="analytics-panel">
      <div className="analytics-panel-heading"><h2>Tickets by priority</h2><span>{summary.activeTickets} on Board</span></div>
      <div className="analytics-table-scroll"><table className="analytics-table"><thead><tr><th>Priority</th><th>Backlog</th><th>Board</th><th>Backlog + Board</th></tr></thead><tbody>{data.priorityCounts.map(row => <tr key={row.priority}><td style={{ textTransform: "capitalize" }}>{row.priority}</td><td>{row.backlog}</td><td>{row.active}</td><td>{row.total}</td></tr>)}</tbody></table></div>
      <p className="analytics-panel-note">Counts include unfinished tickets. Done tickets are excluded.</p>
    </section>
    {(summary.completedTickets > data.completedTickets.length || summary.activeTickets > data.activeTickets.length) && <p className="analytics-context">Ticket lists show up to the 500 latest delivered tickets and the 500 oldest active tickets; summary metrics include all tickets.</p>}
    <section className="analytics-panel"><div className="analytics-panel-heading"><h2>Delivered tickets</h2><span>{completed.length} tickets</span></div>{!completed.length ? <p className="analytics-empty">No delivered tickets yet. Mark a ticket Done at its final workflow step to record delivery.</p> : <div className="analytics-table-scroll"><table className="analytics-table"><thead><tr><th>Ticket</th><th>Done</th><th>Completion time</th><th>Lead time</th></tr></thead><tbody>{completed.map((ticket) => <tr key={ticket.id}><td><TicketLink ticket={ticket} onSelect={onTicketSelect} /></td><td>{analyticsDate(ticket.closedAt)}</td><td>{durationLabel(ticket.cycleMs)}</td><td>{durationLabel(ticket.leadMs)}</td></tr>)}</tbody></table></div>}</section>
    <section className="analytics-panel"><div className="analytics-panel-heading"><h2>Work in flight</h2><span>{active.length} tickets</span></div>{!active.length ? <p className="analytics-empty">No active tickets on the board.</p> : <div className="analytics-table-scroll"><table className="analytics-table"><thead><tr><th>Ticket</th><th>Started</th><th>Time in flight</th></tr></thead><tbody>{active.map((ticket) => <tr key={ticket.id}><td><TicketLink ticket={ticket} onSelect={onTicketSelect} /></td><td>{analyticsDate(ticket.startedAt)}</td><td>{durationLabel(ticket.ageMs)}</td></tr>)}</tbody></table></div>}</section>
  </>;
}

function Metric({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) {
  return <article className="analytics-metric"><div>{icon}<span>{label}</span></div><strong>{value}</strong><small>{detail}</small></article>;
}
function TicketLink({ ticket, onSelect }: { ticket: { id: string; number: string; title: string }; onSelect: (id: string) => void }) {
  return <button type="button" className="analytics-ticket-link" onClick={() => onSelect(ticket.id)}><span>{ticket.number}</span>{ticket.title}</button>;
}
