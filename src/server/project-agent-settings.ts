import { DEFAULT_MAX_CONCURRENT_RUNS } from "../shared/types.js";
import { pool, type DatabaseClient } from "./db.js";

export async function concurrencySettings(client: DatabaseClient = pool): Promise<Map<string, number>> {
  const result = await client.query("SELECT project_id, max_concurrent_runs FROM kangentix_project_agent_settings");
  return new Map(result.rows.map((row) => [row.project_id as string, row.max_concurrent_runs as number]));
}
export async function effectiveConcurrency(projectId: string, client: DatabaseClient = pool): Promise<number> {
  const result = await client.query("SELECT max_concurrent_runs FROM kangentix_project_agent_settings WHERE project_id = $1", [projectId]);
  return result.rows[0]?.max_concurrent_runs ?? DEFAULT_MAX_CONCURRENT_RUNS;
}
export async function saveConcurrency(projectId: string, value: number, client: DatabaseClient): Promise<void> {
  if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) throw new Error("Concurrency must be an integer between 1 and 2,147,483,647.");
  await client.query("INSERT INTO kangentix_project_agent_settings(project_id,max_concurrent_runs) VALUES($1,$2) ON CONFLICT(project_id) DO UPDATE SET max_concurrent_runs=EXCLUDED.max_concurrent_runs", [projectId, value]);
}
