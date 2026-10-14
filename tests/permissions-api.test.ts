import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { api } from "../src/server/api.js";
import { pool, mutate, readState } from "../src/server/db.js";
import { ApiError, emptyState, ensureSystemUser, hideSystemUser, publicUser, type StoredProject } from "../src/server/state.js";
import { hashToken } from "../src/server/security.js";
import { projectPermissions, PROJECT_PERMISSIONS } from "../src/shared/permissions.js";

const user = (id: string) => ({ id, name: `Fixture ${id}`, email: `${id}@example.test`, passwordHash: "unused", mustChangePassword: false });

test("legacy state promotes only the initial account and restores its membership in every project", () => {
  const state = emptyState();
  state.users.push(user("first"), user("second"));
  state.projects.push({ roles: { second: "admin" }, memberPermissions: { first: ["generalWrite"] } } as unknown as StoredProject);
  ensureSystemUser(state);
  assert.equal(publicUser(state.users[0]).isSystemUser, true);
  assert.equal(state.users[1].isSystemUser, undefined);
  assert.equal(state.projects[0].roles.first, "admin");
  assert.deepEqual(state.projects[0].memberPermissions!.first, ["generalWrite", "sandboxWrite"]);
  assert.equal(state.projects[0].permissionVersion, 2);
  state.projects[0].memberPermissions!.first = ["generalWrite"];
  delete state.projects[0].roles.first;
  ensureSystemUser(state);
  assert.equal(state.projects[0].roles.first, "admin");
  assert.deepEqual(state.projects[0].memberPermissions!.first, ["generalWrite"]);
});

test("hidden-account projection preserves machine values and names shared with other users", () => {
  for (const name of ["a", "Claude", "[A.*]"]) {
    const state = emptyState();
    state.users.push({ ...user("system-id"), name, isSystemUser: true }, { ...user("regular-id"), name });
    const data = { repository: "Claude/a-repository", model: "claude-sonnet", id: "a-record", filename: "a.md", content: "Claude wrote a document", members: state.users.map(publicUser), audit: [{ userId: "system-id", action: "created", detail: `User ${name} (${state.users[0].email}) created an artifact for cat and ClaudeProvider.` }] };
    const projected = hideSystemUser(state, "regular-id", data);
    assert.equal(projected.repository, data.repository);
    assert.equal(projected.model, data.model);
    assert.equal(projected.id, data.id);
    assert.equal(projected.filename, data.filename);
    assert.equal(projected.content, data.content);
    assert.equal(projected.members.length, 1);
    assert.equal(projected.members[0].name, name);
    assert.equal(JSON.stringify(projected).includes("system-id"), false);
    assert.equal(projected.audit[0].detail.includes(`User ${name} (`), false);
    assert.ok(projected.audit[0].detail.includes("cat and ClaudeProvider"));
  }
});

test("permission boundaries, delegated grants, system protection and locked workflow reviewer edits", async (t) => {
  const state = emptyState();
  const ids = Array.from({ length: 6 }, () => randomUUID());
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
  const invoke = async (path: string, method: string, account: number, params = {}, body?: unknown, query = {}) => {
    const route = api.stack.find(layer => layer.route?.path === path && layer.route.stack.some(handler => handler.method === method))!.route!;
    let status = 200; let result: any;
    const res = { type() { return this; }, send(value: string) { result = JSON.parse(value); return this; }, setHeader() {}, status(value: number) { status = value; return this; }, json(value: unknown) { result = value; return this; } };
    const req = { params, body, query, cookies: { kangentix_session: tokens[account] } };
    try { await route.stack[0].handle(req as unknown as Request, res as unknown as Response, () => {}); }
    catch (error) { if (!(error instanceof ApiError)) throw error; status = error.status; result = { error: error.message }; }
    return { status, result };
  };
  const created = await invoke("/projects", "post", 0, {}, { name: "Project", key: "TEST" });
  const projectId = created.result.id;
  const params = { id: projectId };
  const assign = (actor: number, target: number, permissions: string[], role?: string) => invoke("/projects/:id/members", "post", actor, params, { email: state.users[target].email, permissions, role });
  assert.equal((await assign(0, 1, [])).status, 201);
  assert.equal((await assign(0, 2, ["analytics", "peopleWrite"])).status, 201);
  assert.equal((await assign(0, 3, ["peopleRead"])).status, 201);
  assert.equal((await assign(0, 4, ["workflowWrite"])).status, 201);
  assert.equal((await assign(0, 5, ["generalWrite"])).status, 201);
  assert.equal((await invoke("/projects/:id/users", "get", 1, params)).status, 403);
  assert.equal((await invoke("/projects/:id/users", "get", 3, params)).status, 200);
  assert.equal((await invoke("/projects/:id/users", "get", 3, params, undefined, { search: state.users[1].email })).status, 403);
  assert.equal((await invoke("/projects/:id/users", "get", 2, params, undefined, { search: state.users[1].email })).status, 200);
  assert.equal((await assign(3, 1, [])).status, 403);
  assert.equal((await assign(2, 1, ["analytics", "peopleWrite"])).status, 201);
  assert.equal((await assign(2, 1, ["generalWrite"])).status, 403);
  assert.equal((await assign(2, 4, [])).status, 403);
  assert.equal((await invoke("/projects/:id/members", "post", 2, params, { email: state.users[3].email, role: "admin" })).status, 403);
  const patch = (actor: number, target: number, permissions: string[]) => invoke("/projects/:id/members/:userId", "patch", actor, { ...params, userId: ids[target] }, { permissions });
  assert.equal((await patch(2, 3, ["analytics"])).status, 200);
  assert.equal((await patch(2, 4, [])).status, 403);
  assert.equal((await patch(0, 0, [...PROJECT_PERMISSIONS])).status, 403);
  assert.equal((await invoke("/projects/:id/members/:userId", "delete", 0, { ...params, userId: ids[0] })).status, 403);
  assert.equal((await invoke("/projects/:id/members/:userId", "delete", 2, { ...params, userId: ids[4] })).status, 403);
  assert.equal((await invoke("/projects/:id", "patch", 2, params, { description: "Forbidden" })).status, 403);
  assert.equal((await invoke("/projects/:id", "patch", 5, params, { description: "Allowed" })).status, 200);
  await mutate(current => { current.projects[0].roles[ids[5]] = "admin"; });
  assert.equal((await patch(0, 5, [...PROJECT_PERMISSIONS])).result.role, "admin");
  assert.equal((await invoke("/projects", "post", 5, {}, { name: "Forbidden project", key: "NOPE" })).status, 403);
  assert.equal((await patch(0, 5, ["generalWrite"])).result.role, "member");
  // A People writer with Analytics cannot acquire the separate General/Workflow permissions.
  assert.deepEqual(projectPermissions((await readState()).projects[0], ids[1]), ["analytics", "peopleRead", "peopleWrite"]);

  const first = (await readState()).projects[0].steps[0];
  const manual = { ...first, id: randomUUID(), name: "Review", filename: "review.md", kind: "manual", approverIds: [ids[0]], requiredApprovals: 1 };
  const workflow = (actor: number, steps: unknown[]) => invoke("/projects/:id/workflow", "put", actor, params, { steps });
  assert.equal((await workflow(2, [first, manual])).status, 403);
  assert.equal((await workflow(0, [first, manual])).status, 200);
  const ticket = (await invoke("/projects/:id/tickets", "post", 3, params, { title: "In progress", description: "A real ticket" })).result;
  await invoke("/projects/:id/board/tickets", "post", 0, params, { ticketIds: [ticket.id] });
  const doneId = randomUUID();
  await mutate(current => {
    current.tickets.push({ ...current.tickets[0], id: doneId, status: "closed", closedAt: new Date().toISOString(), workflowSnapshot: structuredClone([first, { ...manual, kind: "manual" as const }]) });
    current.approvals.push({ id: randomUUID(), ticketId: doneId, stepId: manual.id, userId: ids[0], createdAt: new Date().toISOString() });
    current.approvals.push({ id: randomUUID(), ticketId: ticket.id, stepId: first.id, userId: ids[0], createdAt: new Date().toISOString() }, { id: randomUUID(), ticketId: ticket.id, stepId: manual.id, userId: ids[0], createdAt: new Date().toISOString() });
  });
  assert.equal((await workflow(4, [first, { ...manual, approverIds: [], name: "Structural change" }])).status, 409);
  assert.equal((await workflow(4, [first, { ...manual, approverIds: [ids[1]], requiredApprovals: 2 }])).status, 200);
  const after = await readState();
  assert.equal(after.projects[0].steps[1].requiredApprovals, 2);
  assert.deepEqual(after.approvals.filter(approval => approval.ticketId === ticket.id).map(approval => approval.stepId), [first.id]);
  assert.equal(after.approvals.filter(approval => approval.ticketId === doneId).length, 1);
  assert.equal(after.tickets.find(item => item.id === doneId)!.workflowSnapshot![1].requiredApprovals, 1);
  await mutate(current => {
    current.approvals.push({ id: randomUUID(), ticketId: ticket.id, stepId: manual.id, userId: ids[0], createdAt: new Date().toISOString() });
  });
  // Changing only the count also invalidates prior reviews without altering Done history.
  assert.equal((await workflow(4, [first, { ...manual, approverIds: [ids[1]], requiredApprovals: 1 }])).status, 200);
  const countChanged = await readState();
  assert.equal(countChanged.approvals.some(approval => approval.ticketId === ticket.id && approval.stepId === manual.id), false);
  assert.equal(countChanged.approvals.filter(approval => approval.ticketId === doneId).length, 1);
  assert.deepEqual(countChanged.tickets.find(item => item.id === doneId)!.workflowSnapshot, after.tickets.find(item => item.id === doneId)!.workflowSnapshot);
  assert.equal((await workflow(4, [first, { ...manual, approverIds: [randomUUID()], requiredApprovals: 1 }])).status, 400);
  // General and Sandbox/model settings have independent grants, including mixed payloads.
  assert.equal((await invoke("/projects/:id", "patch", 5, params, { model: "new-model" })).status, 403);
  assert.equal((await invoke("/projects/:id", "patch", 5, params, { description: "Mixed", dockerImage: "sandbox:new" })).status, 403);
  assert.equal((await patch(0, 3, ["sandboxRead"])).status, 200);
  assert.equal((await invoke("/projects/:id", "patch", 3, params, { model: "new-model" })).status, 403);
  assert.equal((await patch(0, 3, ["sandboxWrite"])).status, 200);
  assert.equal((await invoke("/projects/:id", "patch", 3, params, { model: "new-model", dockerImage: "sandbox:new" })).status, 200);
  assert.equal((await invoke("/projects/:id", "patch", 3, params, { description: "Mixed", dockerImage: "sandbox:new" })).status, 403);
  assert.deepEqual(projectPermissions((await readState()).projects[0], ids[3]), ["sandboxRead", "sandboxWrite"]);

  // Concurrent cached board responses retain distinct projections for system and ordinary users.
  await mutate(current => {
    current.artifacts.push({ id: randomUUID(), ticketId: ticket.id, stepId: manual.id, filename: "review.md", content: "Review content", version: 1, updatedAt: new Date().toISOString(), updatedBy: ids[0] });
    const threadId = randomUUID();
    current.threads.push({ id: threadId, ticketId: ticket.id, stepId: manual.id, title: "Discussion", createdBy: ids[0], createdAt: new Date().toISOString() });
    current.messages.push({ id: randomUUID(), threadId, role: "user", authorId: ids[0], content: "A discussion message", createdAt: new Date().toISOString() });
    current.audit.push({ id: randomUUID(), projectId, ticketId: ticket.id, userId: ids[0], action: "member.assigned", detail: `Assigned ${state.users[0].name} (${state.users[0].email}) ${ids[0]}`, createdAt: new Date().toISOString() });
    current.approvals.push({ id: randomUUID(), ticketId: ticket.id, stepId: manual.id, userId: ids[0], createdAt: new Date().toISOString() });
  });
  for (const order of [[0, 2], [2, 0]]) {
    const boards = await Promise.all(order.map(account => invoke("/projects/:id", "get", account, params)));
    for (const [index, board] of boards.entries()) {
      const system = order[index] === 0;
      assert.equal(board.status, 200);
      assert.equal(board.result.members.some((member: any) => member.id === ids[0]), system);
      assert.equal(board.result.project.roles[ids[0]], system ? "admin" : undefined);
      if (!system) {
        const serialized = JSON.stringify(board.result);
        for (const identity of [ids[0], state.users[0].email, state.users[0].name]) assert.equal(serialized.includes(identity), false);
        assert.equal(board.result.project.steps[1].hiddenApproverCount, 1);
        assert.equal(board.result.approvals.find((approval: any) => approval.ticketId === ticket.id && approval.stepId === manual.id).anonymous, true);
      }
    }
  }
  const detail = await invoke("/tickets/:id/detail", "get", 2, { id: ticket.id });
  assert.equal(detail.status, 200);
  for (const identity of [ids[0], state.users[0].email, state.users[0].name]) assert.equal(JSON.stringify(detail.result).includes(identity), false);
  assert.equal(detail.result.messages[0].authorId, null);
  assert.equal(detail.result.artifacts[0].updatedBy, "");
  const session = await invoke("/auth/me", "get", 2);
  assert.equal(JSON.stringify(session.result).includes(ids[0]), false);
  const lookup = await invoke("/projects/:id/users", "get", 2, params, undefined, { search: state.users[0].email });
  assert.deepEqual(lookup.result, []);
  assert.equal((await patch(2, 0, [])).status, 404);
  assert.equal((await workflow(4, [first, { ...manual, approverIds: [ids[0]], requiredApprovals: 1 }])).status, 403);
  // Hidden reviewer assignments are retained across visible edits.
  assert.ok((await readState()).projects[0].steps[1].approverIds.includes(ids[0]));

  // Kanban admission needs no sprint, rejects duplicate or non-backlog selections,
  // and locks workflow structure for every active ticket.
  assert.equal((await invoke("/projects/:id/board/tickets", "post", 0, params, { ticketIds: [ticket.id] })).status, 409);
  const backlog = (await invoke("/projects/:id/tickets", "post", 3, params, { title: "Next idea", description: "Required context" })).result;
  assert.equal((await invoke("/projects/:id/board/tickets", "post", 0, params, { ticketIds: [backlog.id, backlog.id] })).status, 400);
  const direct = (await invoke("/projects/:id/tickets", "post", 3, params, { title: "Direct to Board", description: "Required context", status: "active", attachments: [] })).result;
  assert.equal(direct.status, "active");
  assert.equal(direct.stepId, first.id);
  assert.ok(direct.startedAt);
  assert.equal((await invoke("/projects/:id", "get", 0, params)).result.workflowLocked, true);
  await assert.rejects(invoke("/projects/:id/tickets", "post", 3, params, { title: "Missing context", description: "   " }));
  const withMarkdown = (await invoke("/projects/:id/tickets", "post", 3, params, { title: "Board with Markdown", description: "Required context", status: "active", attachments: [{ filename: "context.md", contentType: "text/markdown", data: Buffer.from("# Board context").toString("base64") }] })).result;
  assert.equal(withMarkdown.status, "active");
  assert.equal(withMarkdown.attachments.length, 1);
  assert.equal(withMarkdown.attachments[0].contentType, "text/markdown");
  const oldNumber = direct.number;
  assert.equal((await invoke("/projects/:id", "patch", 2, params, { key: "NEXT" })).status, 403);
  assert.equal((await invoke("/projects/:id", "patch", 0, params, { key: "NEXT" })).status, 200);
  const numbered = (await invoke("/projects/:id/tickets", "post", 3, params, { title: "New prefix", description: "Required context" })).result;
  assert.equal(numbered.number, `NEXT-${Number(withMarkdown.number.split("-").at(-1)) + 1}`);
  assert.equal((await readState()).tickets.find(item => item.id === direct.id)!.number, oldNumber);
  const other = (await invoke("/projects", "post", 0, {}, { name: "Other project", key: "OTHER" })).result;
  assert.equal((await invoke("/projects/:id", "patch", 0, params, { key: "OTHER" })).status, 409);
  assert.equal((await invoke("/projects/:id/board/tickets", "post", 0, { id: other.id }, { ticketIds: [numbered.id] })).status, 409);
  const markdownId = randomUUID();
  await mutate(current => {
    current.tickets.find(item => item.id === numbered.id)!.attachments.push({ id: markdownId, filename: "notes.md", contentType: "text/markdown", size: 20 });
    current.attachmentData[markdownId] = Buffer.from("uploaded-needle").toString("base64");
    current.artifacts.push({ id: randomUUID(), ticketId: numbered.id, stepId: first.id, filename: "notes.md", content: "document-needle", version: 1, updatedAt: new Date().toISOString(), updatedBy: ids[0] });
  });
  for (const q of ["uploaded-needle", "document-needle"]) {
    assert.deepEqual((await invoke("/projects/:id/tickets/search", "get", 3, params, undefined, { q })).result.ticketIds, [numbered.id]);
    assert.deepEqual((await invoke("/projects/:id/tickets/search", "get", 0, { id: other.id }, undefined, { q })).result.ticketIds, []);
  }
  const returned = await invoke("/tickets/:id/backlog", "post", 3, { id: direct.id });
  assert.equal(returned.result.status, "backlog");
  assert.equal(returned.result.startedAt, null);

});
