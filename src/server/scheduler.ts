import { DEFAULT_MAX_CONCURRENT_RUNS } from "../shared/types.js";
/** One admission per eligible project per round. Persisted FIFO order is supplied by the repository. */
export function fairAdmissions<T extends { id: string; ticketId: string; projectId: string }>(
  queues: Map<string, T[]>, limits: Map<string, number>, reservations: Map<string, number>,
  afterProject: string | undefined, batchSize = 32,
) {
  const projects = [...queues.keys()].sort();
  const after = afterProject ? projects.indexOf(afterProject) : -1;
  const order = projects.slice(after + 1).concat(projects.slice(0, after + 1));
  const admitted: T[] = [];
  const tickets = new Set<string>();
  const counts = new Map(reservations);
  let lastProject = afterProject;
  let progress = true;
  while (progress && admitted.length < batchSize) {
    progress = false;
    for (const projectId of order) {
      if (admitted.length >= batchSize) break;
      if ((counts.get(projectId) || 0) >= (limits.get(projectId) ?? DEFAULT_MAX_CONCURRENT_RUNS)) continue;
      const queue = queues.get(projectId)!;
      const run = queue.shift();
      if (!run) continue;
      progress = true;
      if (tickets.has(run.ticketId)) continue;
      tickets.add(run.ticketId);
      admitted.push(run);
      counts.set(projectId, (counts.get(projectId) || 0) + 1);
      lastProject = projectId;
    }
  }
  return { admitted, lastProject };
}
