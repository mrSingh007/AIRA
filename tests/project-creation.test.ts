import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { api } from "../src/server/api.js";
import { pool, mutate, readState } from "../src/server/db.js";
import { ApiError, canCreateProjects, emptyState, ensureSystemUser, type StoredProject } from "../src/server/state.js";
import { hashToken } from "../src/server/security.js";

const user = (id: string) => ({ id, name: "Fixture", email: `${id}@example.test`, passwordHash: "unused", mustChangePassword: false });

test("project creation capability belongs only to the protected system user", () => {
  const state = emptyState();
  assert.equal(canCreateProjects(state, "unknown"), false);
  state.users.push(user("first"), user("second"));
  ensureSystemUser(state);
  assert.equal(canCreateProjects(state, "first"), true);
  assert.equal(canCreateProjects(state, "second"), false);
  state.projects.push({ roles: { first: "member", second: "admin" } } as unknown as StoredProject);
  assert.equal(canCreateProjects(state, "first"), true);
  assert.equal(canCreateProjects(state, "second"), false);
  assert.equal(canCreateProjects(state, "outsider"), false);
  state.projects[0].roles.second = "member";
  assert.equal(canCreateProjects(state, "second"), false);
});

test("POST projects enforces current transaction permissions, authentication, and bootstrap without database access", async (t) => {
  const state = emptyState();
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const tokens = ids.map((_, index) => String(index + 1).repeat(64));
  state.users.push(...ids.map(user));
  state.sessions.push(...ids.map((userId, index) => ({ userId, tokenHash: hashToken(tokens[index]), expiresAt: new Date(Date.now() + 60_000).toISOString() })));
  const queries: string[] = [];
  let core = structuredClone(state);
  const records = new Map<string, { kind: string; record_id: string; document: unknown }>();
  const query = async (sql: string, values?: string[]) => {
    queries.push(sql);
    if (sql.startsWith("UPDATE kangentix_state")) core = { ...core, ...JSON.parse(values![0]) };
    if (sql.startsWith("INSERT INTO kangentix_records")) {
      for (const record of JSON.parse(values![0])) records.set(`${record.kind}:${record.id}`, { kind: record.kind, record_id: record.id, document: record.document });
    }
    const rows = sql.startsWith("SELECT jsonb_build_object") ? [{ document: structuredClone(core) }] :
      sql.startsWith("SELECT kind,record_id,document") ? [...records.values()] : [];
    return { rows, rowCount: 0 };
  };
  t.mock.method(pool, "connect", async () => ({ query, release() {} }));
  t.mock.method(pool, "query", query);
  const invoke = async (path: string, method: string, account: number | null, body?: unknown) => {
    const route = api.stack.find(layer => layer.route?.path === path && layer.route.stack.some(handler => handler.method === method))!.route!;
    let status = 200;
    let result: any;
    const res = { status(value: number) { status = value; return this; }, json(value: unknown) { result = value; return this; } };
    const req = { body, cookies: account === null ? {} : { kangentix_session: tokens[account] } };
    try { await route.stack[0].handle(req as Request, res as unknown as Response, () => {}); }
    catch (error) {
      if (!(error instanceof ApiError)) throw error;
      status = error.status; result = { error: error.message };
    }
    return { status, json: async () => result };
  };
  const create = (account: number | null, key = "NEW") => invoke("/projects", "post", account, { name: "New project", key });
  const session = async (account: number) => (await invoke("/auth/me", "get", account)).json();
  assert.equal((await create(null)).status, 401);
  assert.equal((await session(0)).canCreateProjects, true);
  assert.equal((await session(1)).canCreateProjects, false);
  assert.equal((await create(1)).status, 403);
  assert.equal((await readState()).projects.length, 0);
  const initial = await create(0);
  assert.equal(initial.status, 201);
  const initialProject = await initial.json();
  assert.equal(initialProject.roles[ids[0]], "admin");
  await mutate(current => { current.projects[0].roles[ids[1]] = "member"; });
  // The initial account remains the system user after bootstrap.
  const earlierSession = await session(0);
  assert.equal(earlierSession.canCreateProjects, true);
  assert.equal((await session(0)).canCreateProjects, true);
  const beforeDenied = await readState();
  for (const account of [1, 2]) {
    queries.length = 0;
    const response = await create(account, "NEW");
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /system user/);
    assert.ok(queries.includes("ROLLBACK"));
    assert.ok(!queries.some(sql => sql.startsWith("UPDATE") || sql.startsWith("INSERT")));
    assert.deepEqual(await readState(), beforeDenied);
  }
  await mutate(current => { current.projects[0].roles[ids[1]] = "admin"; current.users[1].mustChangePassword = true; });
  assert.equal((await create(1, "NEXT")).status, 403);
  await mutate(current => { current.users[1].mustChangePassword = false; });
  assert.equal((await session(1)).canCreateProjects, false);
  assert.equal((await create(1, "NEXT")).status, 403);
  // Revoking a regular administrator cannot confer or retain project creation.
  await mutate(current => { current.projects[0].roles[ids[1]] = "member"; });
  assert.equal((await session(1)).canCreateProjects, false);
  assert.equal((await create(1, "NEXT")).status, 403);
  const next = await create(0, "NEXT");
  assert.equal(next.status, 201);
  assert.equal((await next.json()).roles[ids[0]], "admin");
  assert.equal((await readState()).projects[1].roles[ids[0]], "admin");
  assert.equal((await create(0, "NEXT")).status, 409);
  const committed = await readState();
  assert.equal(committed.projects.length, 2);
  assert.equal(committed.audit.filter(event => event.action === "project.created").length, 2);
});
