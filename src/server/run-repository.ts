import { DEFAULT_MAX_CONCURRENT_RUNS, type Run, type SandboxProvider } from "../shared/types.js";
import { pool, type DatabaseClient } from "./db.js";

export interface RunLifecycle {
  runId: string;
  projectId: string;
  reservationHeld: boolean;
  phase: string;
  provider: SandboxProvider | null;
  sandboxId: string | null;
  cleanupCredential: string | null;
  cleanupAttempts: number;
  nextCleanupAt: string | null;
  expiresAt: string | null;
}
export interface RunFilters {
  projectId?: string;
  ticketId?: string;
  status?: Run["status"];
  reservationHeld?: boolean;
  eligible?: boolean;
  limit?: number;
  offset?: number;
  before?: { createdAt: string; id: string };
  latestPerStep?: boolean;
  newestFirst?: boolean;
}
const iso = (value: Date | string | null) => value instanceof Date ? value.toISOString() : value;
function fromRow(row: Record<string, any>): Run {
  return { ...row.document, projectId: row.project_id, status: row.status,
    createdAt: iso(row.created_at), startedAt: iso(row.started_at), finishedAt: iso(row.finished_at),
    eligibleAt: iso(row.eligible_at), attempts: row.attempts,
    cleanupStatus: row.reservation_held && (row.status === "completed" || row.status === "failed" || row.phase === "cleanup") ? "pending" : row.phase === "settled" ? "complete" : "none",
    logSealed: !!row.sealed };
}
export async function listRuns(filters: RunFilters = {}, client: DatabaseClient = pool): Promise<Run[]> {
  const values: unknown[] = [];
  const predicates: string[] = [];
  const add = (sql: string, value: unknown) => { values.push(value); predicates.push(sql.replace("?", `$${values.length}`)); };
  if (filters.projectId) add("r.project_id = ?", filters.projectId);
  if (filters.ticketId) add("r.ticket_id = ?", filters.ticketId);
  if (filters.status) add("r.status = ?", filters.status);
  if (filters.reservationHeld !== undefined) add("r.reservation_held = ?", filters.reservationHeld);
  if (filters.eligible) predicates.push("r.eligible_at <= now()");
  if (filters.before) { values.push(filters.before.createdAt, filters.before.id); predicates.push(`(r.created_at,r.id) < ($${values.length - 1}::timestamptz,$${values.length})`); }
  const where = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
  const selection = filters.latestPerStep ? `SELECT * FROM (SELECT r.*,l.sealed,row_number() OVER(PARTITION BY r.ticket_id,r.document->>'stepId',r.document->>'kind' ORDER BY r.created_at DESC,r.id DESC) AS history_rank FROM aira_runs r LEFT JOIN aira_run_logs l ON l.run_id=r.id ${where}) latest WHERE history_rank=1 OR reservation_held` : `SELECT r.*,l.sealed FROM aira_runs r LEFT JOIN aira_run_logs l ON l.run_id=r.id ${where}`;
  values.push(Math.min(filters.limit ?? 100_000, 100_000), filters.offset ?? 0);
  const result = await client.query(`${selection} ORDER BY created_at ${filters.newestFirst ? "DESC" : "ASC"},id ${filters.newestFirst ? "DESC" : "ASC"} LIMIT $${values.length-1} OFFSET $${values.length}`, values);
  return result.rows.map(fromRow);
}
export async function getRun(id: string, client: DatabaseClient = pool): Promise<Run | null> {
  const result = await client.query("SELECT r.*,l.sealed FROM aira_runs r LEFT JOIN aira_run_logs l ON l.run_id=r.id WHERE r.id=$1", [id]);
  return result.rows[0] ? fromRow(result.rows[0]) : null;
}
export async function ticketBusy(ticketId: string, client: DatabaseClient = pool): Promise<boolean> {
  const result = await client.query("SELECT 1 FROM aira_runs WHERE ticket_id=$1 AND status IN ('pending','running') LIMIT 1", [ticketId]);
  return !!result.rowCount;
}
export async function enqueueRun(run: Run, projectId: string, client: DatabaseClient): Promise<void> {
  await client.query("INSERT INTO aira_runs(id,project_id,ticket_id,status,created_at,document) VALUES($1,$2,$3,$4,$5,$6::jsonb)", [run.id,projectId,run.ticketId,run.status,run.createdAt,JSON.stringify(run)]);
  await client.query("INSERT INTO aira_run_logs(run_id) VALUES($1)", [run.id]);
}
export async function updateRun(run: Run, client: DatabaseClient = pool): Promise<void> {
  await client.query("UPDATE aira_runs SET status=$2,started_at=$3,finished_at=$4,document=$5::jsonb,eligible_at=COALESCE($6::timestamptz,eligible_at),attempts=COALESCE($7,attempts) WHERE id=$1", [run.id,run.status,run.startedAt,run.finishedAt,JSON.stringify(run),run.eligibleAt ?? null,run.attempts ?? null]);
}
/** Caller holds the application state lock. Live capacity and the reservation are checked atomically. */
export async function claimRun(runId: string, provider: SandboxProvider, client: DatabaseClient): Promise<boolean> {
  const result = await client.query("UPDATE aira_runs AS r SET status='running', started_at=now(), reservation_held=true,phase='preparing',provider=$2 WHERE id=$1 AND status='pending' AND eligible_at <= now() AND NOT reservation_held AND (SELECT count(*) FROM aira_runs held WHERE held.project_id=r.project_id AND held.reservation_held) < COALESCE((SELECT max_concurrent_runs FROM aira_project_agent_settings settings WHERE settings.project_id=r.project_id),$3) RETURNING id", [runId,provider,DEFAULT_MAX_CONCURRENT_RUNS]);
  return !!result.rowCount;
}
export async function reservationCounts(client: DatabaseClient = pool): Promise<Map<string, number>> {
  const result = await client.query("SELECT project_id,count(*)::integer AS count FROM aira_runs WHERE reservation_held GROUP BY project_id");
  return new Map(result.rows.map((row) => [row.project_id as string,row.count as number]));
}
export async function listLifecycles(client: DatabaseClient = pool): Promise<RunLifecycle[]> {
  const result = await client.query("SELECT id,project_id,reservation_held,phase,provider,sandbox_id,cleanup_credential,cleanup_attempts,next_cleanup_at,expires_at FROM aira_runs WHERE reservation_held AND status NOT IN ('pending','running') ORDER BY project_id,created_at,id");
  return result.rows.map((row) => ({ runId:row.id,projectId:row.project_id,reservationHeld:row.reservation_held,phase:row.phase,provider:row.provider,sandboxId:row.sandbox_id,cleanupCredential:row.cleanup_credential,cleanupAttempts:row.cleanup_attempts,nextCleanupAt:iso(row.next_cleanup_at),expiresAt:iso(row.expires_at) }));
}
export async function setLifecycle(runId: string, patch: Partial<Omit<RunLifecycle,"runId"|"projectId">>, client: DatabaseClient = pool): Promise<void> {
  const columns: Record<string,string> = {reservationHeld:"reservation_held",phase:"phase",provider:"provider",sandboxId:"sandbox_id",cleanupCredential:"cleanup_credential",cleanupAttempts:"cleanup_attempts",nextCleanupAt:"next_cleanup_at",expiresAt:"expires_at"};
  const values: unknown[] = [runId];
  const assignments = Object.entries(patch).filter(([key,value]) => columns[key] && value !== undefined).map(([key,value]) => {values.push(value);return `${columns[key]}=$${values.length}`;});
  if (assignments.length) await client.query(`UPDATE aira_runs SET ${assignments.join(",")} WHERE id=$1`, values);
}
export async function recoverInterruptedRuns(client: DatabaseClient): Promise<Run[]> {
  const runs = await listRuns({status:"running"},client);
  for (const run of runs) {
    run.status="failed";run.finishedAt=new Date().toISOString();run.error="Execution interrupted by server restart. Its outcome may be uncertain; review before retrying.";
    await updateRun(run,client);
    // Provisioning ownership might be unresolved: retain reservation until reconciliation.
    await client.query("UPDATE aira_runs SET phase=CASE WHEN phase IN ('preparing','finalizing','settled') THEN phase ELSE 'cleanup' END WHERE id=$1", [run.id]);
  }
  return runs;
}
