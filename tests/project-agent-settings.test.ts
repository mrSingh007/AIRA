import assert from "node:assert/strict";
import test from "node:test";
import type { DatabaseClient } from "../src/server/db.js";
import { concurrencySettings, effectiveConcurrency, saveConcurrency } from "../src/server/project-agent-settings.js";
import { DEFAULT_MAX_CONCURRENT_RUNS } from "../src/shared/types.js";

function database(rows: Record<string, unknown>[]) {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const client = { query: async (sql: string, values?: unknown[]) => { calls.push({ sql, values }); return { rows }; } } as unknown as DatabaseClient;
  return { client, calls };
}

test("project concurrency settings stay isolated and absent settings use the shared default", async () => {
  const all = database([{ project_id: "one", max_concurrent_runs: 3 }, { project_id: "two", max_concurrent_runs: 101 }]);
  assert.deepEqual(await concurrencySettings(all.client), new Map([["one", 3], ["two", 101]]));
  const configured = database([{ max_concurrent_runs: 1 }]);
  assert.equal(await effectiveConcurrency("one", configured.client), 1);
  assert.deepEqual(configured.calls[0].values, ["one"]);
  assert.equal(await effectiveConcurrency("missing", database([]).client), DEFAULT_MAX_CONCURRENT_RUNS);
});

test("invalid concurrency values are rejected before database writes", async () => {
  const db = database([]);
  for (const value of [0, -1, 0.5, NaN, Infinity, -Infinity, 2_147_483_648]) {
    await assert.rejects(saveConcurrency("project", value, db.client), /Concurrency must be an integer/);
  }
  assert.deepEqual(db.calls, []);
});

test("concurrency writes parameterize the project and accept integer storage boundaries", async () => {
  const db = database([]);
  const projectId = "project'; DROP TABLE aira_project_agent_settings; --";
  for (const value of [1, 100, 101, 2_147_483_647]) await saveConcurrency(projectId, value, db.client);
  assert.deepEqual(db.calls.map((call) => call.values), [1, 100, 101, 2_147_483_647].map((value) => [projectId, value]));
  assert.ok(db.calls.every((call) => !call.sql.includes(projectId) && call.sql.includes("ON CONFLICT(project_id) DO UPDATE")));
});
