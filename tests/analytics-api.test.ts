import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { api } from "../src/server/api.js";
import { pool, mutate, readState } from "../src/server/db.js";
import { ApiError, canCreateProjects, emptyState, type StoredProject } from "../src/server/state.js";
import { hashToken } from "../src/server/security.js";

const user = (id: string) => ({ id, name: "Fixture", email: `${id}@example.test`, passwordHash: "unused", mustChangePassword: false });

test("analytics API checks grants on every request and records sprint descriptions, cycle starts, carry and Done", async (t) => {
  const state = emptyState();
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const tokens = ids.map((_, index) => String(index + 1).repeat(64));
  state.users.push(...ids.map(user));
  state.sessions.push(...ids.map((userId, index) => ({ userId, tokenHash: hashToken(tokens[index]), expiresAt: new Date(Date.now() + 60_000).toISOString() })));
  let core = structuredClone(state);
  const records = new Map<string, { kind: string; record_id: string; document: unknown }>();
  const query = async (sql: string, values?: string[]) => {
    if (sql.startsWith("UPDATE kangentix_state")) core = { ...core, ...JSON.parse(values![0]) };
    if (sql.startsWith("INSERT INTO kangentix_records")) for (const record of JSON.parse(values![0])) records.set(`${record.kind}:${record.id}`, { kind: record.kind, record_id: record.id, document: record.document });
    const rows = sql.startsWith("SELECT jsonb_build_object") ? [{ document: structuredClone(core) }] : sql.startsWith("SELECT kind,record_id,document") ? [...records.values()] : [];
    return { rows, rowCount: 0 };
  };
  t.mock.method(pool, "connect", async () => ({ query, release() {} }));
  t.mock.method(pool, "query", query);
  const invoke = async (path: string, method: string, account: number | null, params = {}, body?: unknown) => {
    const route = api.stack.find(layer => layer.route?.path === path && layer.route.stack.some(handler => handler.method === method))!.route!;
    let status = 200; let result: any;
    const headers: Record<string, string> = {};
    const res = { setHeader(key: string, value: string) { headers[key] = value; return this; }, status(value: number) { status = value; return this; }, json(value: unknown) { result = value; return this; } };
    const req = { params, body, cookies: account === null ? {} : { kangentix_session: tokens[account] } };
    try { await route.stack[0].handle(req as Request, res as unknown as Response, () => {}); }
    catch (error) { if (!(error instanceof ApiError)) throw error; status = error.status; result = { error: error.message }; }
    return { status, result, headers };
  };
  const created = await invoke("/projects", "post", 0, {}, { name: "Project", key: "TEST" });
  const projectId = created.result.id;
  await mutate(current => { current.projects[0].roles[ids[1]] = "member"; });
  const analytics = (account: number | null) => invoke("/projects/:id/analytics", "get", account, { id: projectId });
  const grant = (account: number, userIds: string[]) => invoke("/projects/:id/analytics-access", "put", account, { id: projectId }, { userIds });
  assert.equal((await analytics(null)).status, 401);
  const allowed = await analytics(0);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers["Cache-Control"], "private, no-store");
  assert.equal((await analytics(1)).status, 403);
  assert.equal((await analytics(2)).status, 404);
  assert.equal((await grant(1, [ids[1]])).status, 403);
  assert.equal((await grant(0, [ids[2]])).status, 400);
  assert.equal((await grant(0, [ids[1], ids[1]])).status, 400);
  assert.equal((await grant(0, [ids[1]])).status, 200);
  assert.equal((await analytics(1)).status, 200);
  await grant(0, []);
  assert.equal((await analytics(1)).status, 403);
  await grant(0, [ids[1]]);
  const createTicket = async () => (await invoke("/projects/:id/tickets", "post", 1, { id: projectId }, { title: "Task" })).result;
  const ticket = await createTicket();
  await assert.rejects(() => invoke("/projects/:id/sprints", "post", 0, { id: projectId }, { description: "x".repeat(2001), ticketIds: [ticket.id] }));
  const sprint = await invoke("/projects/:id/sprints", "post", 0, { id: projectId }, { name: "Sprint", description: "Goal by Friday", ticketIds: [ticket.id] });
  assert.equal(sprint.status, 201);
  assert.equal(sprint.result.description, "Goal by Friday");
  const initialStart = (await readState()).tickets[0].startedAt;
  assert.ok(initialStart);
  const carry = await invoke("/projects/:id/sprints", "post", 0, { id: projectId }, { ticketIds: [] });
  assert.equal(carry.result.description, "");
  assert.deepEqual(carry.result.carriedTicketIds, [ticket.id]);
  assert.equal((await readState()).tickets[0].startedAt, initialStart);
  assert.deepEqual((await readState()).sprints[0].ticketIds, [ticket.id]);
  const returned = await invoke("/tickets/:id/backlog", "post", 1, { id: ticket.id });
  assert.equal(returned.result.startedAt, null);
  await invoke("/tickets/:id/next", "post", 1, { id: ticket.id });
  assert.ok((await readState()).tickets[0].startedAt);
  // Keep final movement on existing approval/agent validation path.
  await mutate(current => {
    const project = current.projects[0];
    project.steps = [{ ...project.steps[0], kind: "manual", requiredApprovals: 1, approverIds: [ids[0]] }];
    current.tickets[0].stepId = project.steps[0].id;
  });
  assert.equal((await invoke("/tickets/:id/next", "post", 1, { id: ticket.id })).status, 409);
  await mutate(current => { current.projects[0].steps[0].requiredApprovals = 0; });
  const done = await invoke("/tickets/:id/next", "post", 1, { id: ticket.id });
  assert.equal(done.result.status, "closed");
  assert.ok(done.result.closedAt);
  assert.ok((await readState()).sprints[1].completedAt);
  assert.equal((await analytics(1)).result.summary.completedTickets, 1);
  await invoke("/projects/:id/members/:userId", "delete", 0, { id: projectId, userId: ids[1] });
  assert.equal((await analytics(1)).status, 404);
  assert.deepEqual((await readState()).projects[0].analyticsMemberIds, []);
});
