import { pool } from "./db.js";
import { redact } from "./security.js";

export const LOG_TAIL_LIMIT = 200_000;
export const LOG_BUFFER_LIMIT = 256_000;
export const TOTAL_LOG_BUFFER_LIMIT = 8_000_000;
const OMITTED = "\n[Buffered output omitted while log persistence was unavailable.]\n";
interface Stream {
  pending: string;
  inflight?: { text: string; sequence: number };
  sequence: number;
  secrets: string[];
  sealed: boolean;
  omitted?: boolean;
}
const streams = new Map<string, Stream>();
type LogBatch = Array<{ id: string; stream: Stream; text: string; sequence: number }>;
let retryBatch: LogBatch | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let flushing: Promise<void> | undefined;
let backoff = 500;
let total = 0;

function schedule(delay = 500) {
  if (timer) return;
  timer = setTimeout(() => {
    timer = undefined;
    void flushRunLogs().catch(() => {
      console.error("Run log persistence unavailable; bounded output retained for retry.");
      backoff = Math.min(10_000, backoff * 2);
      schedule(backoff);
    });
  }, delay);
  timer.unref();
}
export async function openRunLog(runId: string, secrets: string[] = []) {
  let stream = streams.get(runId);
  if (!stream) {
    await pool.query("INSERT INTO kangentix_run_logs(run_id) VALUES ($1) ON CONFLICT DO NOTHING", [runId]);
    const result = await pool.query("SELECT last_sequence, sealed FROM kangentix_run_logs WHERE run_id=$1", [runId]);
    stream = { pending: "", sequence: Number(result.rows[0].last_sequence), secrets, sealed: result.rows[0].sealed };
    streams.set(runId, stream);
  } else stream.secrets = secrets;
  const selected = stream;
  return {
    write: async (line: string) => {
      if (selected.sealed) throw new Error("Cannot append to a sealed run log.");
      const raw = `${new Date().toISOString()} ${redact(line, selected.secrets)}\n`;
      if (raw.length > LOG_BUFFER_LIMIT) selected.omitted = true;
      const text = raw.slice(-LOG_BUFFER_LIMIT);
      total -= selected.pending.length;
      selected.pending += text;
      const available = LOG_BUFFER_LIMIT - (selected.inflight?.text.length || 0);
      if (selected.pending.length > available) {
        selected.omitted = true;
        selected.pending = available ? selected.pending.slice(-available) : "";
      }
      total += selected.pending.length;
      // In-flight batches are immutable until acknowledged; discard only unsent tails.
      for (const entry of streams.values()) {
        if (total <= TOTAL_LOG_BUFFER_LIMIT - 1_000_000) break;
        if (!entry.pending) continue;
        total -= entry.pending.length;
        entry.pending = "";
        entry.omitted = true;
      }
      schedule(total > 64_000 ? 0 : 500);
    },
    flush: async () => {
      while (selected.pending || selected.inflight || selected.omitted) await flushRunLogs();
    },
    seal: async () => {
      while (selected.pending || selected.inflight || selected.omitted) await flushRunLogs();
      await pool.query("UPDATE kangentix_run_logs SET sealed=true,version=version+1 WHERE run_id=$1 AND NOT sealed", [runId]);
      selected.sealed = true;
      streams.delete(runId);
    },
  };
}
export function logBufferUsage() {
  return { characters: total, streams: streams.size };
}
export function flushRunLogs(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    const batch: LogBatch = retryBatch ?? [];
    // Keep transient SQL/JSON payloads bounded independently of the registered runs.
    let size = 0;
    if (!retryBatch) for (const [id, stream] of streams) {
      if (!stream.inflight && stream.omitted) {
        total -= stream.pending.length;
        stream.pending = OMITTED + stream.pending.slice(-(LOG_TAIL_LIMIT - OMITTED.length));
        total += stream.pending.length;
        stream.omitted = false;
      }
      if (!stream.inflight && stream.pending) {
        stream.inflight = { text: stream.pending, sequence: stream.sequence + 1 };
        stream.pending = "";
      }
      if (stream.inflight) {
        if (batch.length && size + stream.inflight.text.length > 512_000) break;
        batch.push({ id, stream, ...stream.inflight });
        size += stream.inflight.text.length;
        if (size >= 512_000) break;
      }
    }
    if (!batch.length) return;
    retryBatch = batch;
    // last_sequence makes an acknowledgement lost after COMMIT safe to retry.
    await pool.query(`UPDATE kangentix_run_logs AS l SET tail=right(l.tail || b.text,$2),
      version=l.version+1,last_sequence=b.sequence
      FROM jsonb_to_recordset($1::jsonb) AS b(id text,text text,sequence bigint)
      WHERE l.run_id=b.id AND l.last_sequence < b.sequence AND NOT l.sealed`,
      [JSON.stringify(batch.map(({ id, text, sequence }) => ({ id, text, sequence }))), LOG_TAIL_LIMIT]);
    for (const { id, stream, text, sequence } of batch) {
      total -= text.length;
      stream.sequence = sequence;
      stream.inflight = undefined;
      // Rotate acknowledged streams behind their peers so continuously busy
      // early streams cannot starve another run's diagnostics.
      if (streams.get(id) === stream) { streams.delete(id); streams.set(id, stream); }
    }
    retryBatch = undefined;
    backoff = 500;
    if ([...streams.values()].some((stream) => stream.pending || stream.inflight || stream.omitted)) schedule();
  })().finally(() => { flushing = undefined; });
  return flushing;
}
export async function readRunLogs(runId: string, version?: number) {
  const result = await pool.query("SELECT tail,version,sealed FROM kangentix_run_logs WHERE run_id=$1", [runId]);
  const row = result.rows[0] || { tail: "", version: 0, sealed: false };
  return Number(row.version) === version
    ? { tail: "", version: Number(row.version), sealed: row.sealed, unchanged: true }
    : { tail: row.tail as string, version: Number(row.version), sealed: row.sealed };
}
