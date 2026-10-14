import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { original } from "immer";
import type { Member, ProjectData, TicketDetailData, Step, Ticket } from "../shared/types.js";
import { DEFAULT_E2B_TEMPLATE } from "../shared/types.js";
import { PROJECT_PERMISSIONS, projectPermissions, hasProjectPermission } from "../shared/permissions.js";
import { readState, mutate, checkDatabase } from "./db.js";
import {
  authenticate,
  clearSession,
  decrypt,
  encrypt,
  issueSession,
  hashToken,
  redact,
} from "./security.js";
import {
  ApiError,
  assert,
  id,
  now,
  publicUser,
  publicProject,
  projectFor,
  ticketFor,
  membersFor,
  sessionData,
  workflowLocked,
  currentStep,
  busy,
  advanceCurrentStep,
  enqueue,
  writeArtifact,
  audit,
  canAccess,
  canCreateProjects,
  type State,
  type StoredProject,
  ensureSystemUser,
  hideSystemUser,
} from "./state.js";
import { admitToSprint, canViewAnalytics, projectAnalytics } from "./analytics.js";
import { implementationReady } from "../shared/workflow.js";
import { verifyGitHubConnection } from "./github.js";
import { attachmentInput, replaceAttachments } from "./attachments.js";

import { listRuns, getRun } from "./run-repository.js";
import { saveConcurrency } from "./project-agent-settings.js";
import { readRunLogs } from "./run-logs.js";
import { wakeWorker } from "./worker.js";

export const api = Router();
const identifier = z.string().uuid();
const name = z.string().trim().min(1).max(120);
const email = z.string().trim().toLowerCase().email().max(254);
const password = z
  .string()
  .min(10, "Use at least 10 characters for a password.")
  .max(72)
  .refine(
    (v) => Buffer.byteLength(v) <= 72,
    "Password must be at most 72 UTF-8 bytes.",
  );
const content = z.string().max(500_000);
const prompt = z.string().trim().min(1).max(30_000);
const repository = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Use owner/repository.")
  .max(210);
const model = z
  .string()
  .trim()
  .min(1)
  .max(150)
  .regex(/^[A-Za-z0-9_.:/-]+$/, "Invalid model name.");
const token = z.string().trim().max(10_000);
const priority = z.enum(["low", "medium", "high", "urgent"]);
const param = (req: Request, key: string) => String(req.params[key]);
const activeSprint = (state: State, projectId: string) =>
  state.sprints.find((s) => s.projectId === projectId && !s.endedAt);
async function verifyConnection(githubToken: string, repo?: string) {
  try {
    return await verifyGitHubConnection(githubToken, repo);
  } catch (error) {
    throw new ApiError(
      502,
      redact(
        error instanceof Error
          ? error.message
          : "GitHub could not verify this connection.",
        [githubToken],
      ).slice(0, 2000),
    );
  }
}

const authAttempts = new Map<string, { count: number; until: number }>();
function limitAuth(req: Request, account?: string) {
  const key = account
    ? `account:${hashToken(account)}`
    : `address:${req.ip || "unknown"}`;
  const timestamp = Date.now();
  if (authAttempts.size >= 10_000)
    for (const [key, value] of authAttempts)
      if (value.until <= timestamp) authAttempts.delete(key);
  let entry = authAttempts.get(key);
  if (!entry || entry.until <= timestamp) {
    assert(
      entry || authAttempts.size < 10_000,
      429,
      "Too many sign-in attempts. Try again in 15 minutes.",
    );
    entry = { count: 0, until: timestamp + 15 * 60_000 };
    authAttempts.set(key, entry);
  }
  assert(
    ++entry.count <= 30,
    429,
    "Too many sign-in attempts. Try again in 15 minutes.",
  );
}
function defaultSteps(): Step[] {
  return [
    {
      id: id(),
      name: "Todo",
      kind: "sprint",
      filename: "todo.md",
      instructions: "",
      model: "",
      requiredApprovals: 0,
      approverIds: [],
      includePriorArtifacts: false,
    },
  ];
}
function stepForWrite(
  project: StoredProject,
  ticket: Ticket,
  stepId: string,
): Step {
  const step = currentStep(project, ticket);
  assert(
    step.id === stepId,
    409,
    "Only the ticket’s current step can be changed.",
  );
  return step;
}

api.get("/health", async (_req, res) => {
  await checkDatabase();
  res.json({ status: "ok" });
});
api.get("/auth/status", async (_req, res) => {
  const state = await readState();
  res.json({ needsSetup: state.users.length === 0 });
});
api.post("/auth/setup", async (req, res) => {
  limitAuth(req);
  const input = z.object({ name, email, password }).parse(req.body);
  const passwordHash = await bcrypt.hash(input.password, 12);
  const result = await mutate(async (state, client) => {
    assert(
      !state.users.length,
      409,
      "Kangentix has already been set up. Please sign in.",
    );
    const user = {
      id: id(),
      name: input.name,
      email: input.email,
      passwordHash,
      mustChangePassword: false,
      isSystemUser: true,
    };
    state.users.push(user);
    issueSession(state, req, res, user.id);
    return sessionData(state, user, client);
  });
  res.status(201).json(result);
});
api.post("/auth/login", async (req, res) => {
  limitAuth(req);
  const input = z
    .object({ email, password: z.string().min(1).max(200) })
    .parse(req.body);
  limitAuth(req, input.email);
  const initial = await readState();
  const user = initial.users.find((u) => u.email === input.email);
  // Always hash-check, including unknown addresses, to make account probing less useful.
  const valid = await bcrypt.compare(
    input.password,
    user?.passwordHash ||
      "$2b$12$3euPcmQFCiblsZeEu5s7UObbvGc/FELUr9EMk6.Cki.qWnoMFGRi6",
  );
  assert(user && valid, 401, "Email or password is incorrect.");
  const result = await mutate(async (state, client) => {
    const current = state.users.find((u) => u.id === user.id);
    assert(
      current && current.passwordHash === user.passwordHash,
      401,
      "Password changed. Please sign in again.",
    );
    issueSession(state, req, res, user.id);
    return sessionData(state, current, client);
  });
  res.json(result);
});
api.post("/auth/logout", async (req, res) => {
  await mutate(async (state, client) => clearSession(state, req, res));
  res.json({ ok: true });
});
api.get("/auth/me", async (req, res) => {
  const state = await readState();
  res.json(await sessionData(state, authenticate(state, req, true)));
});
api.post("/auth/password", async (req, res) => {
  limitAuth(req);
  const input = z
    .object({
      currentPassword: z.string().min(1).max(200),
      newPassword: password,
    })
    .parse(req.body);
  assert(
    input.currentPassword !== input.newPassword,
    400,
    "Choose a new password different from the initial password.",
  );
  const initial = await readState();
  const user = authenticate(initial, req, true);
  limitAuth(req, user.email);
  assert(
    await bcrypt.compare(input.currentPassword, user.passwordHash),
    400,
    "Current password is incorrect.",
  );
  const passwordHash = await bcrypt.hash(input.newPassword, 12);
  const result = await mutate(async (state, client) => {
    const current = authenticate(state, req, true);
    assert(
      current.passwordHash === user.passwordHash,
      409,
      "Your password was changed in another session. Sign in again.",
    );
    current.passwordHash = passwordHash;
    current.mustChangePassword = false;
    state.sessions = state.sessions.filter((s) => s.userId !== current.id);
    issueSession(state, req, res, current.id);
    return sessionData(state, current, client);
  });
  res.json(result);
});
api.post("/projects", async (req, res) => {
  const input = z
    .object({
      name,
      key: z
        .string()
        .trim()
        .toUpperCase()
        .regex(
          /^[A-Z][A-Z0-9]{1,9}$/,
          "Project key must be 2–10 letters or digits and begin with a letter.",
        ),
      description: z.string().max(10_000).default(""),
    })
    .parse(req.body);
  const result = await mutate(async (state, client) => {
    const user = authenticate(state, req);
    assert(canCreateProjects(state, user.id), 403, "Project administrator access is required to create projects.");
    assert(
      !state.projects.some((p) => p.key === input.key),
      409,
      "This project key is already used.",
    );
    const project: StoredProject = {
      id: id(),
      ...input,
      repository: "",
      baseBranch: "main",
      model: "nemotron-3-ultra:cloud",
      modelProvider: "ollama",
      sandboxProvider: "docker",
      dockerImage: process.env.SANDBOX_DOCKER_IMAGE || "kangentix-sandbox:local",
      e2bTemplate: DEFAULT_E2B_TEMPLATE,
      steps: defaultSteps(),
      roles: { [user.id]: "admin" },
      analyticsMemberIds: [],
      permissionVersion: 2,
      githubConnected: false,
      githubIdentity: "",
      hasOllamaKey: false,
      hasClaudeKey: false,
      hasE2bKey: false,
      secrets: { githubToken: "", ollamaApiKey: "", claudeApiKey: "", e2bApiKey: "" },
    };
    state.projects.push(project);
    ensureSystemUser(state);
    audit(
      state,
      project.id,
      null,
      user.id,
      "project.created",
      `Project ${project.key} created.`,
    );
    return publicProject(project, client);
  });
  res.status(201).json(await viewerResponse(req, result));
});
async function viewerResponse<T>(req: Request, value: T): Promise<T> {
  const state = await readState();
  const user = authenticate(state, req, true);
  return hideSystemUser(state, user.id, value);
}
const boardsInFlight = new Map<string, { state: State; body: Promise<string> }>();
async function boardBody(state: State, project: StoredProject, viewerId: string): Promise<string> {
  const tickets = state.tickets.filter((t) => t.projectId === project.id);
  const ticketIds = new Set(tickets.map((t) => t.id));
  const result: ProjectData = {
    project: await publicProject(project),
    members: membersFor(state, project),
    tickets: tickets.map(ticket => ({ ...ticket, description: ticket.description.slice(0, 200),
      workflowSnapshot: ticket.workflowSnapshot?.map(step => ({ ...step, instructions: "" })) ?? null })),
    sprints: state.sprints.filter((s) => s.projectId === project.id),
    artifacts: state.artifacts.filter((a) => ticketIds.has(a.ticketId)).map(a => ({...a, content: ""})),
    approvals: state.approvals.filter((a) => ticketIds.has(a.ticketId)),
    threads: [], messages: [],
    runs: await listRuns({projectId: project.id, latestPerStep: true}),
    audit: state.audit.filter((a) => a.projectId === project.id && !a.ticketId).slice(-50),
    workflowLocked: workflowLocked(state, project),
  };
  return JSON.stringify(hideSystemUser(state, viewerId, result));
}
api.get("/projects/:id", async (req, res) => {
  const state = await readState();
  const user = authenticate(state, req);
  const project = projectFor(state, param(req, "id"), user.id);
  // Concurrent polls of one committed snapshot share their database reads and
  // encoding. Each request still authorizes independently; no response is cached.
  const cacheKey = `${project.id}:${user.id}`;
  let pending = boardsInFlight.get(cacheKey);
  if (!pending || pending.state !== state) {
    const body = boardBody(state, project, user.id).finally(() => {
      if (boardsInFlight.get(cacheKey)?.body === body) boardsInFlight.delete(cacheKey);
    });
    pending = { state, body };
    boardsInFlight.set(cacheKey, pending);
  }
  res.setHeader("Cache-Control", "private, no-store");
  res.type("application/json").send(await pending.body);
});
api.get("/projects/:id/tickets/search", async (req, res) => {
  const state = await readState();
  const user = authenticate(state, req);
  const project = projectFor(state, param(req, "id"), user.id);
  const query = z.string().max(200).parse(req.query.q ?? "").toLowerCase();
  const ticketIds = state.tickets.filter(ticket => ticket.projectId === project.id &&
    `${ticket.number} ${ticket.title} ${ticket.description}`.toLowerCase().includes(query)).map(ticket => ticket.id);
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ ticketIds });
});
function historyCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({createdAt,id})).toString("base64url");
}
function decodeCursor(raw: unknown): {createdAt: string;id: string} | undefined {
  if (raw === undefined) return undefined;
  assert(typeof raw === "string" && raw.length < 1000, 400, "Invalid history cursor.");
  try {
    const decoded = JSON.parse(Buffer.from(raw,"base64url").toString());
    return z.object({createdAt:z.iso.datetime(),id:identifier}).parse(decoded);
  } catch { throw new ApiError(400,"Invalid history cursor."); }
}
api.get("/tickets/:id/detail", async (req, res) => {
  const state = await readState();
  const user = authenticate(state,req);
  const {ticket} = ticketFor(state,param(req,"id"),user.id);
  const threads = state.threads.filter(t => t.ticketId === ticket.id);
  const threadIds = new Set(threads.map(t => t.id));
  const runs = await listRuns({ticketId:ticket.id,limit:51,newestFirst:true,before:decodeCursor(req.query.runsBefore)});
  const moreRuns = runs.length > 50;
  const pageRuns = runs.slice(0,50).reverse();
  const summaries = await listRuns({ticketId:ticket.id,latestPerStep:true});
  const detailRuns = [...new Map([...pageRuns,...summaries].map(run => [run.id,run])).values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
  const auditBefore = decodeCursor(req.query.auditBefore);
  const audits = state.audit.filter(a => a.ticketId === ticket.id && (!auditBefore || a.createdAt < auditBefore.createdAt || (a.createdAt === auditBefore.createdAt && a.id < auditBefore.id))).sort((a,b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const pageAudit = audits.slice(0,50).reverse();
  const result: TicketDetailData = {
    ticket, artifacts:state.artifacts.filter(a => a.ticketId === ticket.id),
    approvals:state.approvals.filter(a => a.ticketId === ticket.id),threads,
    messages:state.messages.filter(m => threadIds.has(m.threadId)),
    runs:detailRuns,audit:pageAudit,
    nextRunsCursor:moreRuns ? historyCursor(pageRuns[0].createdAt,pageRuns[0].id) : null,
    nextAuditCursor:audits.length > 50 ? historyCursor(pageAudit[0].createdAt,pageAudit[0].id) : null,
    runsPageOldest:pageRuns.length ? { id:pageRuns[0].id, createdAt:pageRuns[0].createdAt } : null,
    auditPageOldest:pageAudit.length ? { id:pageAudit[0].id, createdAt:pageAudit[0].createdAt } : null,
  };
  res.setHeader("Cache-Control","private, no-store");
  res.json(await viewerResponse(req, result));
});
api.get("/runs/:id/logs", async (req,res) => {
  const state = await readState();
  const user = authenticate(state,req);
  const run = await getRun(param(req,"id"));
  assert(run,404,"Execution not found.");
  projectFor(state,run.projectId,user.id);
  const version = req.query.version === undefined ? undefined : z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(req.query.version);
  res.setHeader("Cache-Control","private, no-store");
  res.json(await viewerResponse(req, await readRunLogs(run.id,version)));
});
const projectPatch = z.object({
  name: name.optional(),
  description: z.string().max(10_000).optional(),
  repository: repository.or(z.literal("")).optional(),
  baseBranch: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(
      /^(?!-)(?!.*\.\.)(?!.*[@{}~^:?*\[\\\s])[A-Za-z0-9_.\/-]+$/,
      "Invalid branch name.",
    )
    .optional(),
  model: model.optional(),
  modelProvider: z.enum(["ollama", "claude"]).optional(),
  sandboxProvider: z.enum(["docker", "e2b"]).optional(),
  maxConcurrentRuns: z.number().int().min(1).max(2_147_483_647).optional(),
  dockerImage: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$/)
    .optional(),
  e2bTemplate: z
    .string()
    .trim()
    .max(200)
    .regex(/^[A-Za-z0-9_-]*$/)
    .optional(),
  ollamaApiKey: token.optional(),
  claudeApiKey: token.optional(),
  e2bApiKey: token.optional(),
  githubToken: token.optional(),
});
function assertSettingsPermissions(project: StoredProject, userId: string, input: z.infer<typeof projectPatch>) {
  const generalFields = new Set(["name", "description", "repository", "baseBranch", "githubToken"]);
  const keys = Object.keys(input);
  if (keys.some(key => generalFields.has(key))) assert(hasProjectPermission(project, userId, "generalWrite"), 403, "General write permission is required.");
  if (keys.some(key => !generalFields.has(key))) assert(hasProjectPermission(project, userId, "sandboxWrite"), 403, "Sandbox and model write permission is required.");
}
api.patch("/projects/:id", async (req, res) => {
  const input = projectPatch.parse(req.body);
  const initial = await readState();
  const user = authenticate(initial, req);
  const previous = projectFor(initial, param(req, "id"), user.id);
  assertSettingsPermissions(previous, user.id, input);
  const githubToken =
    input.githubToken ?? decrypt(previous.secrets.githubToken);
  const nextRepo = input.repository ?? previous.repository;
  const needsVerification =
    !!githubToken &&
    (input.githubToken !== undefined || nextRepo !== previous.repository);
  const verified = needsVerification
    ? await verifyConnection(githubToken, nextRepo || undefined)
    : null;
  const result = await mutate(async (state, client) => {
    const actor = authenticate(state, req);
    const project = projectFor(state, previous.id, actor.id);
    assertSettingsPermissions(project, actor.id, input);
    assert(
      project.secrets.githubToken === previous.secrets.githubToken &&
        project.repository === previous.repository,
      409,
      "GitHub settings changed while verification was running. Try again.",
    );
    const {
      ollamaApiKey,
      claudeApiKey,
      e2bApiKey,
      githubToken: githubInput,
      maxConcurrentRuns,
      ...settings
    } = input;
    Object.assign(project, settings);
    if (maxConcurrentRuns !== undefined) await saveConcurrency(project.id,maxConcurrentRuns,client);
    if (verified && nextRepo)
      project.repository =
        verified.repositories.find(
          (r) => r.fullName.toLowerCase() === nextRepo.toLowerCase(),
        )?.fullName || nextRepo;
    if (ollamaApiKey !== undefined)
      project.secrets.ollamaApiKey = encrypt(ollamaApiKey);
    if (claudeApiKey !== undefined) project.secrets.claudeApiKey = encrypt(claudeApiKey);
    if (e2bApiKey !== undefined) project.secrets.e2bApiKey = encrypt(e2bApiKey);
    if (githubInput !== undefined)
      project.secrets.githubToken = encrypt(githubInput);
    if (verified) project.githubIdentity = verified.identity;
    if (!project.secrets.githubToken) project.githubIdentity = "";
    audit(
      state,
      project.id,
      null,
      actor.id,
      "project.updated",
      `Project settings updated: ${
        Object.keys(input)
          .filter((k) => !/key|token/i.test(k))
          .join(", ") || "credentials"
      }${maxConcurrentRuns === undefined ? "" : ` (concurrent sandboxes: ${maxConcurrentRuns})`}.`,
    );
    return publicProject(project, client);
  });
  if (input.maxConcurrentRuns !== undefined) wakeWorker();
  res.json(await viewerResponse(req, result));
});
api.post("/projects/:id/github/connect", async (req, res) => {
  const input = z
    .object({ token: token.optional(), repository: repository.optional() })
    .parse(req.body);
  const initial = await readState();
  const user = authenticate(initial, req);
  const previous = projectFor(initial, param(req, "id"), user.id, "generalWrite");
  const githubToken = input.token || decrypt(previous.secrets.githubToken);
  assert(githubToken, 400, "Enter a GitHub access token.");
  const repo = input.repository || previous.repository;
  const result = await verifyConnection(githubToken, repo || undefined);
  await mutate(async (state, client) => {
    const actor = authenticate(state, req);
    const project = projectFor(state, previous.id, actor.id, "generalWrite");
    assert(
      project.secrets.githubToken === previous.secrets.githubToken &&
        project.repository === previous.repository,
      409,
      "GitHub settings changed while verification was running. Try again.",
    );
    project.secrets.githubToken = encrypt(githubToken);
    project.githubIdentity = result.identity;
    if (input.repository) {
      const selected = result.repositories.find(
        (r) => r.fullName.toLowerCase() === input.repository!.toLowerCase(),
      );
      project.repository = selected?.fullName || input.repository;
      project.baseBranch = selected?.defaultBranch || project.baseBranch;
    }
    audit(
      state,
      project.id,
      null,
      actor.id,
      "github.connected",
      `GitHub identity ${result.identity} connected${repo ? ` to ${repo}` : ""}.`,
    );
  });
  res.json(await viewerResponse(req, result));
});
const stepSchema = z.object({
  id: identifier,
  name,
  kind: z.enum(["sprint", "manual", "definition", "implement"]),
  instructions: z.string().max(30_000),
  model: model.or(z.literal("")),
  requiredApprovals: z.number().int().min(0).max(50),
  approverIds: z.array(identifier).max(100),
  includePriorArtifacts: z.boolean(),
  filename: z
    .string()
    .max(100)
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9_-]*\.md$/,
      "Use a simple Markdown filename, for example define.md.",
    ),
});
api.put("/projects/:id/workflow", async (req, res) => {
  const input = z
    .object({ steps: z.array(stepSchema).min(1).max(20) })
    .parse(req.body);
  const result = await mutate(async (state, client) => {
    const user = authenticate(state, req);
    const project = projectFor(state, param(req, "id"), user.id, "workflowWrite");
    const hiddenIds = state.users.filter(candidate => candidate.isSystemUser && !user.isSystemUser).map(candidate => candidate.id);
    if (hiddenIds.length) {
      for (const step of input.steps) {
        assert(!step.approverIds.some(id => hiddenIds.includes(id)), 403, "Reviewer assignments cannot include hidden accounts.");
        const previous = project.steps.find(candidate => candidate.id === step.id);
        step.approverIds.push(...(previous?.approverIds.filter(id => hiddenIds.includes(id)) ?? []));
      }
    }
    const locked = workflowLocked(state, project);
    const first = input.steps[0];
    assert(
      first.kind === "sprint" && first.id === project.steps[0].id,
      400,
      "The first step must retain its identity, kind, and first position.",
    );
    assert(
      input.steps.slice(1).every((s) => s.kind !== "sprint"),
      400,
      "Only the first step may be the ticket parking step.",
    );
    assert(
      new Set(input.steps.map((s) => s.id)).size === input.steps.length,
      400,
      "Step IDs must be unique.",
    );
    assert(
      new Set(input.steps.map((s) => s.name.toLowerCase())).size ===
        input.steps.length,
      400,
      "Step names must be unique.",
    );
    assert(
      new Set(input.steps.map((s) => s.filename.toLowerCase())).size ===
        input.steps.length,
      400,
      "Step filenames must be unique.",
    );
    if (locked) {
      assert(
        input.steps.length === project.steps.length,
        409,
        "Workflow is locked. Cannot add or remove steps.",
      );
      for (const [index, step] of input.steps.entries()) {
        const previous = project.steps[index];
        assert(
          step.id === previous.id,
          409,
          "Workflow is locked. Cannot replace or reorder steps.",
        );
        const agentStep =
          previous.kind === "definition" || previous.kind === "implement";
        const fields = Object.keys(step) as (keyof typeof step)[];
        const disallowed = fields.filter(
          (key) =>
            key !== "approverIds" && key !== "requiredApprovals" &&
            !(agentStep && (key === "model" || key === "instructions")) &&
            JSON.stringify(step[key]) !== JSON.stringify(previous[key]),
        );
        assert(
          !disallowed.length,
          409,
          `Workflow is locked. Cannot change: ${disallowed.join(", ")}. Reviewer rules may be updated, along with model and instructions for agent steps.`,
        );
      }
    }
    for (const step of input.steps) {
      const previous = project.steps.find((s) => s.id === step.id);
      assert(
        !previous || previous.filename === step.filename,
        400,
        "Existing step filenames are stable and cannot be changed.",
      );
      if (step.kind === "sprint" || step.kind === "manual") {
        step.instructions = "";
        step.model = "";
        step.includePriorArtifacts = false;
      }
      assert(
        step.approverIds.length === new Set(step.approverIds).size,
        400,
        "Approvers must be distinct users.",
      );
      step.requiredApprovals = step.approverIds.length
        ? Math.max(1, step.requiredApprovals)
        : 0;
      assert(
        step.requiredApprovals <= step.approverIds.length,
        400,
        `${step.name} needs enough named approvers for its required count.`,
      );
      assert(
        step.approverIds.every(
          (uid) =>
            state.users.some((u) => u.id === uid) &&
            canAccess(project, uid),
        ),
        400,
        "Every approver must be a project member.",
      );
    }
    const changedRules = new Set(input.steps.filter(step => {
      const previous = project.steps.find(item => item.id === step.id);
      return !previous || previous.requiredApprovals !== step.requiredApprovals ||
        JSON.stringify([...previous.approverIds].sort()) !== JSON.stringify([...step.approverIds].sort());
    }).map(step => step.id));
    project.steps = input.steps;
    const activeIds = new Set(state.tickets.filter(ticket => ticket.projectId === project.id && ticket.status === "active").map(ticket => ticket.id));
    state.approvals = state.approvals.filter(approval => !activeIds.has(approval.ticketId) || (locked && !changedRules.has(approval.stepId)));
    audit(
      state,
      project.id,
      null,
      user.id,
      "workflow.updated",
      locked
        ? "Workflow settings saved; approvals for changed reviewer rules cleared."
        : `Workflow saved with ${input.steps.length} steps.`,
    );
    return publicProject(project, client);
  });
  res.json(await viewerResponse(req, result));
});
api.get("/projects/:id/users", async (req, res) => {
  const state = await readState();
  const actor = authenticate(state, req);
  const project = projectFor(state, param(req, "id"), actor.id, "peopleRead");
  const search =
    typeof req.query.search === "string"
      ? req.query.search.trim().toLowerCase().slice(0, 254)
      : "";
  assert(!search || hasProjectPermission(project, actor.id, "peopleWrite"), 403, "People write permission is required to search users.");
  const users: Member[] = state.users
    .filter((u) => (!u.isSystemUser || actor.isSystemUser) && (
      project.roles[u.id]
        ? !search ||
          u.email.includes(search) ||
          u.name.toLowerCase().includes(search)
        : !!search && u.email === search),
    )
    .map((u) => ({
      ...publicUser(u),
      role: project.roles[u.id] || "member",
      permissions: projectPermissions(project, u.id),
    }));
  res.json(await viewerResponse(req, users));
});
const memberInput = z.object({
  email,
  name: name.optional(),
  password: password.optional(),
  role: z.enum(["admin", "member"]).optional(),
  permissions: z.array(z.enum(["analytics", "peopleRead", "peopleWrite", "workflowWrite", "generalRead", "generalWrite", "sandboxRead", "sandboxWrite"])).max(PROJECT_PERMISSIONS.length).optional(),
});

async function saveMember(req: Request, res: Response, input: z.infer<typeof memberInput>, targetUserId?: string) {
  const result = await mutate(async (state, client) => {
    const actor = authenticate(state, req);
    const project = projectFor(state, param(req, "id"), actor.id, "peopleWrite");
    let user = state.users.find((u) => targetUserId ? u.id === targetUserId : u.email === input.email);
    if (targetUserId) assert(user && project.roles[targetUserId], 404, "Project member not found.");
    if (!user) {
      assert(
        input.password && input.name,
        400,
        "Provide a name and initial password to create this user.",
      );
      user = {
        id: id(),
        email: input.email,
        name: input.name,
        passwordHash: await bcrypt.hash(input.password, 12),
        mustChangePassword: true,
      };
      state.users.push(user);
    }
    assert(!user.isSystemUser, actor.isSystemUser ? 403 : 404, actor.isSystemUser ? "The system user’s project access cannot be changed." : "Project member not found.");
    const actorPermissions = projectPermissions(project, actor.id);
    assert(projectPermissions(project, user.id).every(permission => actorPermissions.includes(permission)), 403, "You cannot change members with permissions you do not have.");
    const permissions = [...new Set(input.permissions ?? (input.role === "admin" ? [...PROJECT_PERMISSIONS] : input.role === "member" ? [] : projectPermissions(project, user.id)))];
    for (const [write, read] of [["peopleWrite", "peopleRead"], ["generalWrite", "generalRead"], ["sandboxWrite", "sandboxRead"]] as const) {
      if (permissions.includes(write) && !permissions.includes(read)) permissions.push(read);
    }
    assert(permissions.every(permission => actorPermissions.includes(permission)), 403, "You can grant only permissions you have.");
    const nextRole = project.roles[user.id] === "admin" && input.role !== "member" &&
      PROJECT_PERMISSIONS.every(permission => permissions.includes(permission)) ? "admin" : "member";
    project.roles[user.id] = nextRole;
    project.memberPermissions ??= {};
    project.memberPermissions[user.id] = permissions;
    project.analyticsMemberIds = (project.analyticsMemberIds ?? []).filter(id => id !== user!.id);
    audit(
      state,
      project.id,
      null,
      actor.id,
      "member.assigned",
      `${user.email} assigned with project role ${nextRole}.`,
    );
    return { ...publicUser(user), role: nextRole, permissions };
  });
  res.status(targetUserId ? 200 : 201).json(await viewerResponse(req, result));
}
api.post("/projects/:id/members", async (req, res) => {
  await saveMember(req, res, memberInput.parse(req.body));
});
api.patch("/projects/:id/members/:userId", async (req, res) => {
  const input = memberInput.pick({ permissions: true }).required().parse(req.body);
  await saveMember(req, res, { email: "", ...input }, param(req, "userId"));
});
api.delete("/projects/:id/members/:userId", async (req, res) => {
  await mutate(async (state, client) => {
    const actor = authenticate(state, req);
    const project = projectFor(state, param(req, "id"), actor.id, "peopleWrite");
    const userId = param(req, "userId");
    assert(project.roles[userId], 404, "Project member not found.");
    assert(!state.users.find(user => user.id === userId)?.isSystemUser, actor.isSystemUser ? 403 : 404, actor.isSystemUser ? "The system user cannot be removed from a project." : "Project member not found.");
    const actorPermissions = projectPermissions(project, actor.id);
    assert(projectPermissions(project, userId).every(permission => actorPermissions.includes(permission)), 403, "You cannot remove members with permissions you do not have.");
    assert(
      !project.steps.some((s) => s.approverIds.includes(userId)),
      409,
      "Remove this user from workflow approver rules before removing project access.",
    );
    delete project.roles[userId];
    if (project.memberPermissions) delete project.memberPermissions[userId];
    project.analyticsMemberIds = (project.analyticsMemberIds ?? []).filter(id => id !== userId);
    audit(
      state,
      project.id,
      null,
      actor.id,
      "member.removed",
      `Project access removed for ${state.users.find((u) => u.id === userId)?.email || userId}.`,
    );
  });
  res.json({ ok: true });
});

api.get("/projects/:id/analytics", async (req, res) => {
  const state = await readState();
  const user = authenticate(state, req);
  const project = projectFor(state, param(req, "id"), user.id);
  assert(canViewAnalytics(project, user.id), 403, "Analytics access is required.");
  res.setHeader("Cache-Control", "private, no-store");
  res.json(projectAnalytics(state, project.id));
});
api.put("/projects/:id/analytics-access", async (req, res) => {
  const input = z.object({ userIds: z.array(identifier).max(2000) }).parse(req.body);
  const result = await mutate(async (state, client) => {
    const actor = authenticate(state, req);
    const project = projectFor(state, param(req, "id"), actor.id, "peopleWrite");
    assert(new Set(input.userIds).size === input.userIds.length, 400, "Analytics users must be unique.");
    assert(input.userIds.every(userId => !!project.roles[userId] && state.users.some(user => user.id === userId)), 400, "Analytics access can only be granted to project members.");
    assert(hasProjectPermission(project, actor.id, "analytics"), 403, "You can grant only permissions you have.");
    for (const userId of Object.keys(project.roles)) {
      const previous = projectPermissions(project, userId);
      const changed = previous.includes("analytics") !== input.userIds.includes(userId);
      if (!changed || project.roles[userId] === "admin") continue;
      assert(previous.every(permission => projectPermissions(project, actor.id).includes(permission)), 403, "You cannot change members with permissions you do not have.");
      project.memberPermissions ??= {};
      project.memberPermissions[userId] = previous.filter(permission => permission !== "analytics");
      if (input.userIds.includes(userId)) project.memberPermissions[userId].push("analytics");
    }
    project.analyticsMemberIds = input.userIds;
    audit(state, project.id, null, actor.id, "analytics.access_updated", "Project analytics access updated.");
    return publicProject(project, client);
  });
  res.json(await viewerResponse(req, result));
});

const ticketInput = z.object({
  title: z.string().trim().min(1).max(250),
  description: z.string().max(50_000).default(""),
  priority: priority.default("medium"),
  attachments: attachmentInput.optional(),
});
api.post("/projects/:id/tickets", async (req, res) => {
  const input = ticketInput.parse(req.body);
  const result = await mutate(async (state, client) => {
    const user = authenticate(state, req);
    const project = projectFor(state, param(req, "id"), user.id);
    // Counting existing tickets must not draft every ticket in the application.
    const sequence =
      (original(state.tickets) ?? state.tickets).reduce((count, ticket) => count + Number(ticket.projectId === project.id), 0) + 1;
    const ticket: Ticket = {
      id: id(),
      projectId: project.id,
      number: `${project.key}-${sequence}`,
      title: input.title,
      description: input.description,
      priority: input.priority,
      attachments: [],
      workflowSnapshot: null,
      status: "backlog",
      stepId: null,
      sprintId: null,
      createdBy: user.id,
      createdAt: now(),
      updatedAt: now(),
      closedAt: null,
      startedAt: null,
      pullRequests: [],
    };
    if (input.attachments) replaceAttachments(state, ticket, input.attachments);
    state.tickets.push(ticket);
    audit(
      state,
      project.id,
      ticket.id,
      user.id,
      "ticket.created",
      `${ticket.number} created in Backlog.`,
    );
    return ticket;
  });
  res.status(201).json(await viewerResponse(req, result));
});
api.get("/tickets/:id/attachments/:attachmentId", async (req, res) => {
  const state = await readState();
  const user = authenticate(state, req);
  const { ticket } = ticketFor(state, param(req, "id"), user.id);
  const attachment = ticket.attachments.find(
    (image) => image.id === param(req, "attachmentId"),
  );
  assert(
    attachment && state.attachmentData[attachment.id],
    404,
    "Ticket image not found.",
  );
  res.setHeader("Content-Type", attachment.contentType);
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader(
    "Content-Disposition",
    `inline; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
  );
  res.send(Buffer.from(state.attachmentData[attachment.id], "base64"));
});
api.patch("/tickets/:id", async (req, res) => {
  const input = z
    .object({
      title: z.string().trim().min(1).max(250).optional(),
      description: z.string().max(50_000).optional(),
      priority: priority.optional(),
      attachments: attachmentInput.optional(),
    })
    .parse(req.body);
  const result = await mutate(async (state, client) => {
    const user = authenticate(state, req);
    const { ticket, project } = ticketFor(state, param(req, "id"), user.id);
    assert(ticket.status !== "closed", 409, "Closed tickets are read-only.");
    assert(
      ticket.status === "backlog" && !ticket.sprintId,
      409,
      "Ticket fields can only be edited in Backlog.",
    );
    assert(
      !await busy(state, ticket.id, client),
      409,
      "Wait for the running agent before editing ticket context.",
    );
    const { attachments, ...fields } = input;
    if (attachments !== undefined)
      replaceAttachments(state, ticket, attachments);
    Object.assign(ticket, fields, { updatedAt: now() });
    audit(
      state,
      project.id,
      ticket.id,
      user.id,
      "ticket.updated",
      "Ticket fields updated.",
    );
    return ticket;
  });
  res.json(await viewerResponse(req, result));
});
api.post("/projects/:id/backlog/action", async (req, res) => {
  const input = z
    .object({
      ticketIds: z.array(identifier).min(1).max(2000),
      action: z.enum(["sprint", "close"]),
    })
    .parse(req.body);
  const result = await mutate(async (state, client) => {
    const user = authenticate(state, req);
    const project = projectFor(state, param(req, "id"), user.id);
    assert(
      new Set(input.ticketIds).size === input.ticketIds.length,
      400,
      "Selected tickets must be unique.",
    );
    const tickets = input.ticketIds.map((ticketId) => {
      const ticket = state.tickets.find(
        (t) =>
          t.id === ticketId &&
          t.projectId === project.id &&
          t.status === "backlog",
      );
      assert(
        ticket,
        409,
        "Selected tickets must belong to this project and still be in Backlog.",
      );
      return ticket;
    });
    const sprint =
      input.action === "sprint" ? activeSprint(state, project.id) : undefined;
    assert(
      input.action !== "sprint" || sprint,
      409,
      "Start a sprint before adding tickets.",
    );
    const timestamp = now();
    if (sprint) sprint.ticketIds ??= state.tickets.filter(ticket => ticket.projectId === project.id && ticket.sprintId === sprint.id).map(ticket => ticket.id);
    for (const ticket of tickets) {
      if (input.action === "sprint") {
        ticket.status = "active";
        ticket.stepId = project.steps[0].id;
        ticket.sprintId = sprint!.id;
        admitToSprint(sprint!, ticket, timestamp);
        audit(
          state,
          project.id,
          ticket.id,
          user.id,
          "ticket.advanced",
          `Backlog → ${project.steps[0].name} (${sprint!.name}).`,
        );
      } else {
        ticket.status = "closed";
        ticket.closedAt = timestamp;
        ticket.workflowSnapshot = null;
        audit(
          state,
          project.id,
          ticket.id,
          user.id,
          "ticket.closed",
          "Closed from Backlog — won’t do.",
        );
      }
      ticket.updatedAt = timestamp;
    }
    return tickets;
  });
  res.json(await viewerResponse(req, result));
});
api.post("/projects/:id/sprints", async (req, res) => {
  const input = z
    .object({ name: name.optional(), description: z.string().trim().max(2000).default(""), ticketIds: z.array(identifier).max(2000) })
    .parse(req.body);
  const result = await mutate(async (state, client) => {
    const user = authenticate(state, req);
    const project = projectFor(state, param(req, "id"), user.id, true);
    assert(
      new Set(input.ticketIds).size === input.ticketIds.length,
      400,
      "Selected tickets must be unique.",
    );
    for (const tid of input.ticketIds)
      assert(
        state.tickets.some(
          (t) =>
            t.id === tid &&
            t.projectId === project.id &&
            t.status === "backlog",
        ),
        409,
        "Selected tickets must belong to this project and still be in Backlog.",
      );
    const previous = activeSprint(state, project.id);
    if (previous) {
      previous.ticketIds ??= state.tickets.filter(ticket => ticket.projectId === project.id && ticket.sprintId === previous.id).map(ticket => ticket.id);
      previous.endedAt = now();
    }
    const sprint = {
      id: id(),
      projectId: project.id,
      name:
        input.name ||
        `Sprint ${state.sprints.filter((s) => s.projectId === project.id).length + 1}`,
      description: input.description,
      ticketIds: [] as string[],
      carriedTicketIds: [] as string[],
      completedAt: null,
      startedAt: now(),
      endedAt: null,
    };
    state.sprints.push(sprint);
    let carried = 0;
    for (const ticket of state.tickets.filter(
      (t) => t.projectId === project.id,
    )) {
      if (ticket.status === "active") {
        ticket.sprintId = sprint.id;
        admitToSprint(sprint, ticket, now(), true);
        ticket.updatedAt = now();
        carried++;
      }
      if (input.ticketIds.includes(ticket.id)) {
        ticket.status = "active";
        ticket.stepId = project.steps[0].id;
        ticket.sprintId = sprint.id;
        admitToSprint(sprint, ticket, now());
        ticket.updatedAt = now();
        audit(
          state,
          project.id,
          ticket.id,
          user.id,
          "ticket.advanced",
          `Backlog → ${project.steps[0].name} (${sprint.name}).`,
        );
      }
    }
    audit(
      state,
      project.id,
      null,
      user.id,
      "sprint.started",
      `${sprint.name} started with ${input.ticketIds.length} backlog tickets and ${carried} carried tickets.`,
    );
    return sprint;
  });
  res.status(201).json(await viewerResponse(req, result));
});
api.post("/tickets/:id/backlog", async (req, res) => {
  const result = await mutate(async (state, client) => {
    const user = authenticate(state, req);
    const { ticket, project } = ticketFor(state, param(req, "id"), user.id);
    const sprint = activeSprint(state, project.id);
    assert(
      ticket.status === "active" && sprint && ticket.sprintId === sprint.id,
      409,
      "Only unfinished tickets in the current sprint can return to Backlog.",
    );
    assert(
      !await busy(state, ticket.id, client),
      409,
      "Wait for the running agent before returning this ticket to Backlog.",
    );
    ticket.status = "backlog";
    ticket.stepId = null;
    ticket.sprintId = null;
    ticket.workflowSnapshot = null;
    ticket.closedAt = null;
    ticket.startedAt = null;
    ticket.updatedAt = now();
    state.approvals = state.approvals.filter(
      (approval) => approval.ticketId !== ticket.id,
    );
    audit(
      state,
      project.id,
      ticket.id,
      user.id,
      "ticket.returned_to_backlog",
      `Returned from ${sprint.name} to Backlog; approvals cleared. Rejoining a sprint starts at the first workflow step.`,
    );
    return ticket;
  });
  res.json(await viewerResponse(req, result));
});
api.post("/tickets/:id/next", async (req, res) => {
  const result = await mutate(async (state, client) => {
    const user = authenticate(state, req);
    const { ticket, project } = ticketFor(state, param(req, "id"), user.id);
    assert(
      !await busy(state, ticket.id, client),
      409,
      "Wait for the running agent before moving this ticket.",
    );
    assert(ticket.status !== "closed", 409, "This ticket is already closed.");
    if (ticket.status === "backlog") {
      const sprint = activeSprint(state, project.id);
      assert(
        sprint,
        409,
        "Start a sprint before adding this ticket.",
      );
      sprint.ticketIds ??= state.tickets.filter(item => item.projectId === project.id && item.sprintId === sprint.id).map(item => item.id);
      ticket.status = "active";
      ticket.stepId = project.steps[0].id;
      ticket.sprintId = sprint.id;
      admitToSprint(sprint, ticket, now());
      audit(
        state,
        project.id,
        ticket.id,
        user.id,
        "ticket.advanced",
        `Backlog → ${project.steps[0].name}.`,
      );
    } else {
      await advanceCurrentStep(state, ticket, project, user.id, client);
    }
    ticket.updatedAt = now();
    return ticket;
  });
  wakeWorker();
  res.json(await viewerResponse(req, result));
});
api.put("/tickets/:id/artifacts/:stepId", async (req, res) => {
  const input = z
    .object({ content, version: z.number().int().min(0).optional() })
    .parse(req.body);
  const result = await mutate(async (state, client) => {
    const user = authenticate(state, req);
    const { ticket, project } = ticketFor(state, param(req, "id"), user.id);
    const step = stepForWrite(project, ticket, param(req, "stepId"));
    assert(
      step.kind === "definition",
      400,
      "Only definition-step documents can be edited.",
    );
    assert(
      !await busy(state, ticket.id, client),
      409,
      "Wait for the running agent before editing the document.",
    );
    const current = state.artifacts.find(
      (a) => a.ticketId === ticket.id && a.stepId === step.id,
    );
    assert(
      input.version === undefined || input.version === (current?.version || 0),
      409,
      "This document changed while you were editing. Reload its latest version.",
    );
    return writeArtifact(state, ticket, step, input.content, user.id);
  });
  res.json(await viewerResponse(req, result));
});
api.post("/tickets/:id/approvals", async (req, res) => {
  const input = z
    .object({
      stepId: identifier,
      artifactVersion: z.number().int().min(1).optional(),
      runId: identifier.optional(),
    })
    .parse(req.body);
  const result = await mutate(async (state, client) => {
    const user = authenticate(state, req);
    const { ticket, project } = ticketFor(state, param(req, "id"), user.id);
    const step = stepForWrite(project, ticket, input.stepId);
    assert(
      !await busy(state, ticket.id, client),
      409,
      "Wait for the running agent before approving.",
    );
    assert(
      step.approverIds.includes(user.id),
      403,
      "You are not a designated approver for this step.",
    );
    if (step.kind === "definition") {
      const artifact = state.artifacts.find(
        (a) => a.ticketId === ticket.id && a.stepId === step.id,
      );
      assert(
        artifact && artifact.content.trim(),
        409,
        "The step needs a document before it can be approved.",
      );
      assert(
        input.artifactVersion === artifact.version,
        409,
        "The document changed. Refresh and review its latest version before approving.",
      );
    }
    if (step.kind === "implement") {
      const runs = await listRuns({ticketId: ticket.id}, client);
      assert(
        implementationReady(ticket, step, runs),
        409,
        `Complete ${step.name} with a pull request or a confirmed no-change result before approving.`,
      );
      const latest = runs
        .filter(
          (run) =>
            run.ticketId === ticket.id &&
            run.stepId === step.id &&
            run.kind === "implement",
        )
        .at(-1)!;
      assert(
        input.runId === latest.id,
        409,
        "The implementation changed. Refresh and review the latest run before approving.",
      );
    }
    assert(
      !state.approvals.some(
        (a) =>
          a.ticketId === ticket.id &&
          a.stepId === step.id &&
          a.userId === user.id,
      ),
      409,
      "You have already approved this step.",
    );
    const approval = {
      id: id(),
      ticketId: ticket.id,
      stepId: step.id,
      userId: user.id,
      createdAt: now(),
    };
    state.approvals.push(approval);
    audit(
      state,
      project.id,
      ticket.id,
      user.id,
      "approval.added",
      `${step.name} approved.`,
    );
    return approval;
  });
  res.status(201).json(await viewerResponse(req, result));
});
api.delete("/tickets/:id/approvals/:stepId", async (req, res) => {
  await mutate(async (state, client) => {
    const user = authenticate(state, req);
    const { ticket, project } = ticketFor(state, param(req, "id"), user.id);
    const step = stepForWrite(project, ticket, param(req, "stepId"));
    assert(
      !await busy(state, ticket.id, client),
      409,
      "Approvals cannot change while an agent execution is pending or running.",
    );
    assert(
      state.approvals.some(
        (a) =>
          a.ticketId === ticket.id &&
          a.stepId === step.id &&
          a.userId === user.id,
      ),
      404,
      "Your approval was not found.",
    );
    state.approvals = state.approvals.filter(
      (a) =>
        a.ticketId !== ticket.id ||
        a.stepId !== step.id ||
        a.userId !== user.id,
    );
    audit(
      state,
      project.id,
      ticket.id,
      user.id,
      "approval.revoked",
      `${step.name} approval revoked.`,
    );
  });
  res.json({ ok: true });
});
api.post("/tickets/:id/runs", async (req, res) => {
  const input = z.object({ stepId: identifier }).parse(req.body);
  const result = await mutate(async (state, client) => {
    const user = authenticate(state, req);
    const { ticket, project } = ticketFor(state, param(req, "id"), user.id);
    const step = stepForWrite(project, ticket, input.stepId);
    return enqueue(state, ticket, step, user.id, null, client);
  });
  wakeWorker();
  res.status(202).json(await viewerResponse(req, result));
});
api.post("/tickets/:id/threads", async (req, res) => {
  const input = z
    .object({ stepId: identifier, content: prompt })
    .parse(req.body);
  const result = await mutate(async (state, client) => {
    const user = authenticate(state, req);
    const { ticket, project } = ticketFor(state, param(req, "id"), user.id);
    const step = stepForWrite(project, ticket, input.stepId);
    assert(
      step.kind === "definition",
      400,
      "Discussions are available in the current definition step.",
    );
    assert(
      !await busy(state, ticket.id, client),
      409,
      "Wait for the running agent before starting a discussion.",
    );
    const thread = {
      id: id(),
      ticketId: ticket.id,
      stepId: step.id,
      title: input.content.slice(0, 90),
      createdBy: user.id,
      createdAt: now(),
    };
    state.threads.push(thread);
    state.messages.push({
      id: id(),
      threadId: thread.id,
      role: "user",
      authorId: user.id,
      content: input.content,
      createdAt: now(),
    });
    await enqueue(state, ticket, step, user.id, thread.id, client);
    return thread;
  });
  wakeWorker();
  res.status(201).json(await viewerResponse(req, result));
});
api.post("/threads/:id/messages", async (req, res) => {
  const input = z.object({ content: prompt }).parse(req.body);
  const result = await mutate(async (state, client) => {
    const user = authenticate(state, req);
    const thread = state.threads.find((t) => t.id === param(req, "id"));
    assert(thread, 404, "Discussion not found.");
    const { ticket, project } = ticketFor(state, thread.ticketId, user.id);
    const step = stepForWrite(project, ticket, thread.stepId);
    assert(
      step.kind === "definition",
      400,
      "Only definition steps support discussions.",
    );
    assert(
      !await busy(state, ticket.id, client),
      409,
      "Wait for the running agent before sending another message.",
    );
    const message = {
      id: id(),
      threadId: thread.id,
      role: "user" as const,
      authorId: user.id,
      content: input.content,
      createdAt: now(),
    };
    state.messages.push(message);
    await enqueue(state, ticket, step, user.id, thread.id, client);
    return message;
  });
  wakeWorker();
  res.status(201).json(await viewerResponse(req, result));
});

api.use((_req: Request, _res: Response) => {
  throw new ApiError(404, "API endpoint not found.");
});
