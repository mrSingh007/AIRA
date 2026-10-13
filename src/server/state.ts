import type { DatabaseClient } from "./db.js";
import { concurrencySettings, effectiveConcurrency } from "./project-agent-settings.js";
import { enqueueRun, listRuns, ticketBusy } from "./run-repository.js";
import { randomUUID } from "node:crypto";
import { current, isDraft } from "immer";
import { DEFAULT_MAX_CONCURRENT_RUNS } from "../shared/types.js";
import {
  implementationReady,
  requiredApprovalCount,
} from "../shared/workflow.js";
import type {
  User,
  Project,
  Ticket,
  Sprint,
  Artifact,
  Approval,
  Thread,
  Message,
  Run,
  AuditEvent,
  Role,
  Step,
  SessionData,
  Member,
} from "../shared/types.js";

export interface StoredUser extends User {
  passwordHash: string;
}
export interface StoredProject extends Omit<Project, "maxConcurrentRuns"> {
  secrets: { githubToken: string; ollamaApiKey: string; claudeApiKey: string; e2bApiKey: string };
}
export interface Session {
  tokenHash: string;
  userId: string;
  expiresAt: string;
}
export interface State {
  users: StoredUser[];
  projects: StoredProject[];
  tickets: Ticket[];
  sprints: Sprint[];
  artifacts: Artifact[];
  revisions: Artifact[];
  approvals: Approval[];
  threads: Thread[];
  messages: Message[];
  audit: AuditEvent[];
  sessions: Session[];
  attachmentData: Record<string, string>;
}
export const emptyState = (): State => ({
  users: [],
  projects: [],
  tickets: [],
  sprints: [],
  artifacts: [],
  revisions: [],
  approvals: [],
  threads: [],
  messages: [],
  audit: [],
  sessions: [],
  attachmentData: {},
});
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function assert(
  condition: unknown,
  status: number,
  message: string,
): asserts condition {
  if (!condition) throw new ApiError(status, message);
}
export function publicUser(user: StoredUser): User {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    mustChangePassword: user.mustChangePassword,
  };
}
export async function publicProject(project: StoredProject, client?: DatabaseClient, limit?: number): Promise<Project> {
  const { secrets: _secrets, ...safe } = project;
  return {
    ...safe,
    maxConcurrentRuns: limit ?? await effectiveConcurrency(project.id, client),
    hasOllamaKey: !!project.secrets.ollamaApiKey,
    hasClaudeKey: !!project.secrets.claudeApiKey,
    hasE2bKey: !!project.secrets.e2bApiKey,
    githubConnected: !!project.secrets.githubToken && !!project.githubIdentity,
  };
}
export function roleFor(
  project: Project | StoredProject,
  userId: string,
): Role | undefined {
  return project.roles[userId];
}
export function canAccess(
  project: Project | StoredProject,
  userId: string,
): boolean {
  return !!roleFor(project, userId);
}
export function projectFor(
  state: State,
  projectId: string,
  userId: string,
  admin = false,
): StoredProject {
  const project = state.projects.find((p) => p.id === projectId);
  assert(
    project && canAccess(project, userId),
    404,
    "Project not found.",
  );
  assert(
    !admin || roleFor(project, userId) === "admin",
    403,
    "Project administrator access is required.",
  );
  return project;
}
export function ticketFor(
  state: State,
  ticketId: string,
  userId: string,
): { ticket: Ticket; project: StoredProject } {
  const ticket = state.tickets.find((t) => t.id === ticketId);
  assert(ticket, 404, "Ticket not found.");
  return { ticket, project: projectFor(state, ticket.projectId, userId) };
}
export function membersFor(state: State, project: StoredProject): Member[] {
  return state.users
    .filter((u) => !!project.roles[u.id])
    .map((u) => ({
      ...publicUser(u),
      role: project.roles[u.id],
    }));
}
export async function sessionData(state: State, user: StoredUser, client?: DatabaseClient): Promise<SessionData> {
  const limits = await concurrencySettings(client);
  return {
    user: publicUser(user),
    projects: await Promise.all(state.projects
      .filter((p) => canAccess(p, user.id))
      .map(p => publicProject(p, client, limits.get(p.id) ?? DEFAULT_MAX_CONCURRENT_RUNS))),
  };
}
export function audit(
  state: State,
  projectId: string,
  ticketId: string | null,
  userId: string | null,
  action: string,
  detail: string,
) {
  state.audit.push({
    id: id(),
    projectId,
    ticketId,
    userId,
    action,
    detail,
    createdAt: now(),
  });
}
export function workflowLocked(state: State, project: Project | StoredProject): boolean {
  const activeSprintIds = new Set(
    state.sprints
      .filter((sprint) => sprint.projectId === project.id && !sprint.endedAt)
      .map((sprint) => sprint.id),
  );
  return state.tickets.some(
    (ticket) =>
      ticket.projectId === project.id &&
      ticket.status === "active" &&
      ticket.sprintId !== null &&
      activeSprintIds.has(ticket.sprintId),
  );
}
export function currentStep(project: Project | StoredProject, ticket: Ticket): Step {
  const step = project.steps.find((s) => s.id === ticket.stepId);
  assert(
    ticket.status === "active" && step,
    409,
    "This ticket is not in an active workflow step.",
  );
  return step;
}
export async function busy(_state: State, ticketId: string, client?: DatabaseClient): Promise<boolean> {
  return ticketBusy(ticketId, client);
}
export function approvalCount(
  state: State,
  ticket: Ticket,
  step: Step,
): number {
  return new Set(
    state.approvals
      .filter(
        (a) =>
          a.ticketId === ticket.id &&
          a.stepId === step.id &&
          step.approverIds.includes(a.userId),
      )
      .map((a) => a.userId),
  ).size;
}
export async function advanceCurrentStep(
  state: State,
  ticket: Ticket,
  project: Project | StoredProject,
  userId: string,
  client: DatabaseClient,
) {
  const runs = await listRuns({ticketId: ticket.id}, client);
  const step = currentStep(project, ticket);
  assert(
    !await busy(state, ticket.id, client),
    409,
    "Wait for the running agent before moving this ticket.",
  );
  assert(
    approvalCount(state, ticket, step) >= requiredApprovalCount(step),
    409,
    `${step.name} needs its required approvals before advancing.`,
  );
  if (step.kind === "implement") {
    assert(
      implementationReady(ticket, step, runs),
      409,
      `Complete ${step.name} with a pull request or a confirmed no-change result before advancing.`,
    );
  }
  if (step.kind === "definition") {
    assert(
      state.artifacts.some(
        (a) =>
          a.ticketId === ticket.id && a.stepId === step.id && a.content.trim(),
      ),
      409,
      "Generate or save the step document before advancing.",
    );
    const latest = runs
      .filter(
        (r) =>
          r.ticketId === ticket.id &&
          r.stepId === step.id &&
          r.kind === "definition",
      )
      .at(-1);
    assert(
      !latest || latest.status === "completed",
      409,
      "The latest generation failed. Retry it successfully before advancing.",
    );
  }
  const nextStep =
    project.steps[project.steps.findIndex((s) => s.id === step.id) + 1];
  if (!nextStep) {
    ticket.workflowSnapshot = structuredClone(isDraft(project.steps) ? current(project.steps) : project.steps);
    ticket.status = "closed";
    ticket.closedAt = now();
    audit(
      state,
      project.id,
      ticket.id,
      userId,
      "ticket.closed",
      `${step.name} completed.`,
    );
    return;
  }
  ticket.stepId = nextStep.id;
  audit(
    state,
    project.id,
    ticket.id,
    userId,
    "ticket.advanced",
    `${step.name} → ${nextStep.name}.`,
  );
  if (nextStep.kind === "definition" || nextStep.kind === "implement")
    await enqueue(state, ticket, nextStep, userId, null, client);
}
export async function enqueue(
  state: State,
  ticket: Ticket,
  step: Step,
  userId: string,
  threadId: string | null = null,
  client: DatabaseClient,
): Promise<Run> {
  assert(
    !await busy(state, ticket.id, client),
    409,
    "This ticket already has a pending or running agent execution.",
  );
  assert(
    step.kind === "definition" || step.kind === "implement",
    400,
    `${step.name} does not execute an agent.`,
  );
  // Regenerating a step changes the work under review, so approval starts again.
  if (!threadId)
    state.approvals = state.approvals.filter(
      (a) => a.ticketId !== ticket.id || a.stepId !== step.id,
    );
  const run: Run = {
    id: id(),
    projectId: ticket.projectId,
    ticketId: ticket.id,
    stepId: step.id,
    threadId,
    kind: threadId
      ? "chat"
      : step.kind === "implement"
        ? "implement"
        : "definition",
    status: "pending",
    cleanupStatus: "none",
    logSealed: false,
    error: null,
    createdAt: now(),
    startedAt: null,
    finishedAt: null,
  };
  await enqueueRun(run, ticket.projectId, client);
  audit(
    state,
    ticket.projectId,
    ticket.id,
    userId,
    "run.queued",
    `${run.kind} run queued.`,
  );
  return run;
}
export function writeArtifact(
  state: State,
  ticket: Ticket,
  step: Step,
  content: string,
  userId: string,
): Artifact {
  let artifact = state.artifacts.find(
    (a) => a.ticketId === ticket.id && a.stepId === step.id,
  );
  if (artifact) {
    state.revisions.push({ ...artifact });
    Object.assign(artifact, {
      content,
      version: artifact.version + 1,
      updatedAt: now(),
      updatedBy: userId,
    });
  } else {
    artifact = {
      id: id(),
      ticketId: ticket.id,
      stepId: step.id,
      filename: step.filename,
      content,
      version: 1,
      updatedAt: now(),
      updatedBy: userId,
    };
    state.artifacts.push(artifact);
  }
  const revoked = state.approvals.filter(
    (a) => a.ticketId === ticket.id && a.stepId === step.id,
  ).length;
  state.approvals = state.approvals.filter(
    (a) => a.ticketId !== ticket.id || a.stepId !== step.id,
  );
  ticket.updatedAt = now();
  audit(
    state,
    ticket.projectId,
    ticket.id,
    userId === "agent" ? null : userId,
    "artifact.updated",
    `${step.filename} saved as version ${artifact.version}; ${revoked} approvals cleared.`,
  );
  return artifact;
}
