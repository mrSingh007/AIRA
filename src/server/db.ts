import pg from "pg";
import { createDraft, current, finishDraft, isDraft, setAutoFreeze, type Draft } from "immer";
setAutoFreeze(false);
import { emptyState, ensureSystemUser, type State } from "./state.js";

export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL || "postgres://kangentix:kangentix@localhost:5432/kangentix",
  max: 8,
  connectionTimeoutMillis: 5000,
});
pool.on("error", () => console.error("PostgreSQL connection interrupted."));
export type DatabaseClient = Pick<pg.PoolClient, "query">;
export const query = pool.query.bind(pool);
export async function initializeDatabase() {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS kangentix_state (id integer PRIMARY KEY CHECK (id = 1), document jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())",
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kangentix_records (
      kind text NOT NULL, record_id text NOT NULL, project_id text NOT NULL,
      position integer NOT NULL, document jsonb NOT NULL,
      PRIMARY KEY(kind,record_id)
    );
    CREATE INDEX IF NOT EXISTS kangentix_records_project ON kangentix_records(project_id,kind,position);
    CREATE TABLE IF NOT EXISTS kangentix_project_agent_settings (
      project_id text PRIMARY KEY, max_concurrent_runs integer NOT NULL CHECK(max_concurrent_runs > 0)
    );
    CREATE TABLE IF NOT EXISTS kangentix_runs (
      id text PRIMARY KEY, project_id text NOT NULL, ticket_id text NOT NULL,
      status text NOT NULL CHECK(status IN ('pending','running','completed','failed')),
      created_at timestamptz NOT NULL, started_at timestamptz, finished_at timestamptz,
      eligible_at timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL DEFAULT 0,
      document jsonb NOT NULL, reservation_held boolean NOT NULL DEFAULT false,
      phase text NOT NULL DEFAULT 'queued', provider text, sandbox_id text,
      cleanup_credential text, cleanup_attempts integer NOT NULL DEFAULT 0,
      next_cleanup_at timestamptz, expires_at timestamptz
    );
    CREATE UNIQUE INDEX IF NOT EXISTS kangentix_runs_ticket_busy ON kangentix_runs(ticket_id) WHERE status IN ('pending','running');
    CREATE INDEX IF NOT EXISTS kangentix_runs_queue ON kangentix_runs(project_id,status,eligible_at,created_at,id);
    CREATE INDEX IF NOT EXISTS kangentix_runs_ticket_history ON kangentix_runs(ticket_id,created_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS kangentix_runs_reservations ON kangentix_runs(project_id,next_cleanup_at) WHERE reservation_held;
    CREATE TABLE IF NOT EXISTS kangentix_run_logs (
      run_id text PRIMARY KEY REFERENCES kangentix_runs(id) ON DELETE CASCADE,
      tail text NOT NULL DEFAULT '', version bigint NOT NULL DEFAULT 0,
      last_sequence bigint NOT NULL DEFAULT 0, sealed boolean NOT NULL DEFAULT false
    );
  `);
  await pool.query(
    "INSERT INTO kangentix_state (id, document) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING",
    [JSON.stringify({users:[],projects:[],sessions:[]})],
  );
}
const operationalKeys = ["tickets", "artifacts", "revisions", "approvals", "threads", "messages", "audit"] as const;
const coreSelection = "jsonb_build_object('users',document->'users','projects',document->'projects','sessions',document->'sessions') AS document";
let committedState: State | undefined;
let committedRecords: Map<string, OperationalRecord> | undefined;
let reading: Promise<State> | undefined;
let mutationTail: Promise<void> = Promise.resolve();
const databaseTiming = { transactions: 0, poolWaitMs: 0, mutationQueueWaitMs: 0, transactionMs: 0, callbackMs: 0, recordDiffMs: 0, commitMs: 0, recordWrites: 0 };
export function databaseMetrics() { return { ...databaseTiming }; }
function hydrate(core: Partial<State>, rows: Array<{kind:string;record_id:string;document:any}>): State {
  const state = { ...emptyState(), ...core };
  for (const row of rows) {
    if (row.kind === "attachmentData") state.attachmentData[row.record_id] = row.document;
    else if ((operationalKeys as readonly string[]).includes(row.kind)) (state[row.kind as typeof operationalKeys[number]] as any[]).push(row.document);
  }
  // Preserve saved workflow configuration while giving the starting step its Kanban identity.
  for (const project of state.projects) {
    if (project.steps?.[0] && (project.steps[0].kind as string) === "sprint") project.steps[0].kind = "parking";
  }
  ensureSystemUser(state);
  return state;
}
/** Committed snapshots are read-only by convention. Only mutate creates a writable copy. */
export async function readState(): Promise<State> {
  if (committedState) return committedState;
  if (!reading) reading = (async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Cache recovery must wait for any original transaction whose COMMIT
      // acknowledgement was lost, then hydrate both stores from one boundary.
      const core = await client.query(`SELECT ${coreSelection} FROM kangentix_state WHERE id=1 FOR UPDATE`);
      const records = await client.query("SELECT kind,record_id,document FROM kangentix_records ORDER BY kind,position,record_id");
      const snapshot = hydrate(core.rows[0].document, records.rows);
      const operational = recordsFor(snapshot);
      await client.query("COMMIT");
      committedState = snapshot;
      committedRecords = operational;
      return snapshot;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  })().finally(() => { reading = undefined; });
  return reading;
}
export async function readProjectState(projectId: string): Promise<State> {
  const state = await readState();
  const ticketIds = new Set(state.tickets.filter(ticket => ticket.projectId === projectId).map(ticket => ticket.id));
  const threads = state.threads.filter(thread => ticketIds.has(thread.ticketId));
  const threadIds = new Set(threads.map(thread => thread.id));
  const attachmentIds = new Set(state.tickets.filter(ticket => ticketIds.has(ticket.id)).flatMap(ticket => ticket.attachments.map(attachment => attachment.id)));
  return { ...state,
    tickets: state.tickets.filter(ticket => ticketIds.has(ticket.id)),
    artifacts: state.artifacts.filter(artifact => ticketIds.has(artifact.ticketId)),
    revisions: state.revisions.filter(artifact => ticketIds.has(artifact.ticketId)),
    approvals: state.approvals.filter(approval => ticketIds.has(approval.ticketId)),
    threads, messages: state.messages.filter(message => threadIds.has(message.threadId)),
    audit: state.audit.filter(event => event.projectId === projectId),
    attachmentData: Object.fromEntries(Object.entries(state.attachmentData).filter(([id]) => attachmentIds.has(id))),
  };
}
interface OperationalRecord { kind:string; id:string; projectId:string; position:number; document:unknown; encoded:string }
function recordsFor(state: State, previous?: Map<string, OperationalRecord>): Map<string, OperationalRecord> {
  const records = new Map<string, OperationalRecord>();
  const tickets = new Map(state.tickets.map(ticket => [ticket.id,ticket.projectId]));
  const threads = new Map(state.threads.map(thread => [thread.id,tickets.get(thread.ticketId) || ""]));
  for (const kind of operationalKeys) for (const [position,document] of state[kind].entries()) {
    const item = document as any;
    const recordId = kind === "revisions" ? `${item.id}:${item.version}:${item.updatedAt}` : item.id;
    const projectId = item.projectId || tickets.get(item.ticketId) || threads.get(item.threadId) || "";
    const old = previous?.get(`${kind}:${recordId}`);
    const record = old?.document === document && old.projectId === projectId && old.position === position
      ? old
      : {kind,id:recordId,projectId,position,document,encoded:old?.document === document ? old.encoded : JSON.stringify(document)};
    records.set(`${kind}:${recordId}`,record);
  }
  const attachmentProjects = new Map(state.tickets.flatMap(ticket => ticket.attachments.map(attachment => [attachment.id,ticket.projectId] as const)));
  for (const [id,document] of Object.entries(state.attachmentData)) {
    const old = previous?.get(`attachmentData:${id}`);
    const projectId = attachmentProjects.get(id) || "";
    records.set(`attachmentData:${id}`,old?.document === document && old.projectId === projectId
      ? old
      : {kind:"attachmentData",id,projectId,position:0,document,encoded:old?.document === document ? old.encoded : JSON.stringify(document)});
  }
  return records;
}
// Returned snapshots must not retain proxies revoked when the transaction finishes.
function detachResult<T>(value: T): T {
  if (isDraft(value)) return current(value as Draft<T>) as T;
  if (Array.isArray(value)) return value.map(item => detachResult(item)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,detachResult(item)])) as T;
  return value;
}
export async function mutate<T>(fn: (state: State, client: DatabaseClient) => T | Promise<T>): Promise<T> {
  // Queue in-process before taking a pool connection. Board/log reads retain access
  // to the pool instead of waiting behind connections blocked on the state lock.
  let release!: () => void;
  const preceding = mutationTail;
  mutationTail = new Promise<void>(resolve => { release = resolve; });
  const queuedAt = performance.now();
  await preceding;
  databaseTiming.mutationQueueWaitMs += performance.now() - queuedAt;
  let client: pg.PoolClient | undefined;
  let draft: State | undefined;
  const started = performance.now();
  try {
    const previous = await readState();
    const state = createDraft(previous);
    draft = state;
    const before = committedRecords || recordsFor(previous);
    const poolStart = performance.now();
    client = await pool.connect();
    databaseTiming.poolWaitMs += performance.now() - poolStart;
    // Every state + queue transaction keeps the canonical lock order even when
    // reading the committed in-process snapshot permitted by the single instance.
    await client.query("BEGIN; SELECT id FROM kangentix_state WHERE id=1 FOR UPDATE");
    const callbackStarted = performance.now();
    const value = detachResult(await fn(state, client));
    databaseTiming.callbackMs += performance.now() - callbackStarted;
    const committed = finishDraft(state);
    draft = undefined;
    if (committed.users !== previous.users || committed.projects !== previous.projects || committed.sessions !== previous.sessions) {
      const core = JSON.stringify({users:committed.users,projects:committed.projects,sessions:committed.sessions});
      const oldCore = JSON.stringify({users:previous.users,projects:previous.projects,sessions:previous.sessions});
      if (core !== oldCore) await client.query("UPDATE kangentix_state SET document=document || $1::jsonb,updated_at=now() WHERE id=1",[core]);
    }
    const diffStarted = performance.now();
    const after = committed === previous ? before : recordsFor(committed, before);
    const changed: Array<{kind:string;id:string;project_id:string;position:number;document:unknown}> = [];
    const removed: Array<{kind:string;id:string}> = [];
    for (const [key,record] of after) {
      const old = before.get(key);
      if (record !== old && (!old || old.encoded !== record.encoded || old.projectId !== record.projectId || old.position !== record.position))
        changed.push({kind:record.kind,id:record.id,project_id:record.projectId,position:record.position,document:record.document});
    }
    for (const [key,record] of before) if (!after.has(key)) removed.push({kind:record.kind,id:record.id});
    databaseTiming.recordDiffMs += performance.now() - diffStarted;
    if (changed.length) await client.query(`INSERT INTO kangentix_records(kind,record_id,project_id,position,document)
      SELECT kind,id,project_id,position,document FROM jsonb_to_recordset($1::jsonb) AS r(kind text,id text,project_id text,position integer,document jsonb)
      ON CONFLICT(kind,record_id) DO UPDATE SET project_id=EXCLUDED.project_id,position=EXCLUDED.position,document=EXCLUDED.document`,[JSON.stringify(changed)]);
    if (removed.length) await client.query(`DELETE FROM kangentix_records existing USING jsonb_to_recordset($1::jsonb) AS removed(kind text,id text) WHERE existing.kind=removed.kind AND existing.record_id=removed.id`,[JSON.stringify(removed)]);
    const commitStarted = performance.now();
    await client.query("COMMIT");
    databaseTiming.commitMs += performance.now() - commitStarted;
    committedState = committed;
    committedRecords = after;
    databaseTiming.transactions++;
    databaseTiming.recordWrites += changed.length + removed.length;
    databaseTiming.transactionMs += performance.now() - started;
    return value;
  } catch (error) {
    committedState = undefined; // Re-read durable state after an uncertain commit.
    committedRecords = undefined;
    if (client) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { if (draft) finishDraft(draft); client?.release();release(); }
}
export async function checkDatabase() {
  await pool.query("SELECT 1");
}
export async function closeDatabase() {
  await pool.end();
}

// Keep a dedicated connection for the process-wide worker lock. A second app
// instance must not cancel or steal the first instance's running jobs.
export async function acquireWorkerLock() {
  const client = await pool.connect();
  const result = await client.query(
    "SELECT pg_try_advisory_lock(41820931) AS locked",
  );
  if (!result.rows[0].locked) {
    client.release();
    throw new Error(
      "Another Kangentix server is active for this database. Run one application instance.",
    );
  }
  client.on("error", () => {
    console.error(
      "Worker database lock lost; stopping to avoid duplicate execution.",
    );
    process.exit(1);
  });
  return async () => {
    await client.query("SELECT pg_advisory_unlock(41820931)");
    client.release();
  };
}
