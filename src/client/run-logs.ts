import type { Run, RunLogData } from "../shared/types";
import { api } from "./api";

/** A single expanded log stream. Closing it cancels requests and suppresses late responses. */
export function pollRunLogs(options: {
  run: Pick<Run, "id" | "status" | "cleanupStatus" | "logSealed">;
  version: number | null;
  receive: (data: RunLogData) => void;
  fail: (error: unknown) => void;
  fetchLogs?: (version: number | null, signal: AbortSignal) => Promise<RunLogData>;
  schedule?: (callback: () => void) => () => void;
}): () => void {
  let alive = true;
  let version = options.version;
  let cancelTimer: (() => void) | undefined;
  const controller = new AbortController();
  const fetchLogs = options.fetchLogs ?? ((version, signal) => api<RunLogData>(
    `/runs/${options.run.id}/logs${version === null ? "" : `?version=${version}`}`,
    "GET", undefined, signal,
  ));
  const schedule = options.schedule ?? ((callback) => {
    const timer = window.setTimeout(callback, 1000);
    return () => window.clearTimeout(timer);
  });
  async function poll() {
    try {
      const result = await fetchLogs(version, controller.signal);
      if (!alive) return;
      version = result.version;
      options.receive(result);
      const run = options.run;
      const settled = run.status !== "pending" && run.status !== "running" && run.cleanupStatus !== "pending";
      if (settled && result.sealed && run.logSealed) return;
    } catch (error) {
      if (!alive) return;
      options.fail(error);
    }
    if (alive) cancelTimer = schedule(() => void poll());
  }
  void poll();
  return () => { alive = false; controller.abort(); cancelTimer?.(); };
}
