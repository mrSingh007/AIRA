import type { DatabaseClient } from "./db.js";
import { concurrencySettings, effectiveConcurrency } from "./project-agent-settings.js";
import { enqueueRun, listRuns, ticketBusy } from "./run-repository.js";
import { randomUUID } from "node:crypto";
import { current, isDraft } from "immer";
import { DEFAULT_MAX_CONCURRENT_RUNS } from "../shared/types.js";
import { hasProjectPermission, projectPermissions } from "../shared/permissions.js";
import {
  implementationReady,
  requiredApprovalCount,
} from "../shared/workflow.js";
import type {
  User,
  ProjectPermission,
  Project,
  Ticket,
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
  permissionVersion?: 2;
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
  artifacts: [],
  revisions: [],
  approvals: [],
  threads: [],
  messages: [],
  audit: [],
  sessions: [],
  attachmentData: {},
});
/** Preserve the original account as the permanent system user across legacy state. */
export function ensureSystemUser(state: State) {
  const systemUser = state.users.find(user => user.isSystemUser) ?? state.users[0];
  if (!systemUser) return;
  systemUser.isSystemUser = true;
  for (const project of state.projects) {
    project.roles[systemUser.id] = "admin";
    if (project.permissionVersion !== 2) {
      for (const permissions of Object.values(project.memberPermissions ?? {})) {
        if (permissions.includes("generalWrite") && !permissions.includes("sandboxWrite")) permissions.push("sandboxWrite");
      }
      project.permissionVersion = 2;
    }
  }
}
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
    isSystemUser: user.isSystemUser,
  };
}
/** Hide the system account from every response to other accounts, retaining approval totals. */
export function hideSystemUser<T>(state: State, viewerId: string, value: T): T {
  if (state.users.some(user => user.id === viewerId && user.isSystemUser)) return value;
  const hidden = state.users.filter(user => user.isSystemUser);
  if (!hidden.length) return value;
  const hiddenIds = new Set(hidden.map(user => user.id));
  const identityText = [...new Set(hidden.flatMap(user => [user.id, user.email]).filter(Boolean))];
  const scrubText = (text: string) => identityText.reduce((result, identity) => result.replaceAll(identity, ""), text);
  const visit = (item: any): any => {
    if (typeof item === "string") return scrubText(item);
    if (Array.isArray(item)) return item.filter(child => !(typeof child === "string" && hiddenIds.has(child)) && !(child && typeof child === "object" && hiddenIds.has(child.id))).map(visit);
    if (!item || typeof item !== "object") return item;
    const result: Record<string, any> = {};
    for (const [key, child] of Object.entries(item)) {
      if (hiddenIds.has(key) || key === "isSystemUser") continue;
      if (["createdBy", "updatedBy", "authorId", "userId"].includes(key) && typeof child === "string" && hiddenIds.has(child)) {
        result[key] = key === "authorId" || (key === "userId" && !!item.action) ? null : "";
      } else result[key] = visit(child);
    }
    if (item.action && typeof item.detail === "string" && hiddenIds.has(item.userId)) {
      let detail = result.detail;
      for (const user of hidden) {
        const escaped = user.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (escaped) detail = detail.replace(new RegExp(`(?<![a-zA-Z0-9_])${escaped}(?![a-zA-Z0-9_])`, "g"), "");
      }
      result.detail = detail;
    }
    if (Array.isArray(item.approverIds)) {
      const count = item.approverIds.filter((id: string) => hiddenIds.has(id)).length;
      if (count) result.hiddenApproverCount = count;
    }
    if (item.ticketId && item.stepId && hiddenIds.has(item.userId) && !item.action) {
      const ticket = state.tickets.find(ticket => ticket.id === item.ticketId);
      const steps = ticket?.status === "closed" ? ticket.workflowSnapshot : state.projects.find(project => project.id === ticket?.projectId)?.steps;
      if (steps?.some(step => step.id === item.stepId && step.approverIds.includes(item.userId))) result.anonymous = true;
    }
    return result;
  };
  return visit(value) as T;
}
export async function publicProject(project: StoredProject, client?: DatabaseClient, limit?: number, viewer?: { state: State; userId: string }): Promise<Project> {
  const { secrets: _secrets, permissionVersion: _version, ...safe } = project;
  const result = {
    ...safe,
    analyticsMemberIds: project.analyticsMemberIds ?? [],
    maxConcurrentRuns: limit ?? await effectiveConcurrency(project.id, client),
    hasOllamaKey: !!project.secrets.ollamaApiKey,
    hasClaudeKey: !!project.secrets.claudeApiKey,
    hasE2bKey: !!project.secrets.e2bApiKey,
    githubConnected: !!project.secrets.githubToken && !!project.githubIdentity,
  };
  return viewer ? hideSystemUser(viewer.state, viewer.userId, result) : result;
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
export function canCreateProjects(state: State, userId: string): boolean {
  return state.users.some(user => user.id === userId && user.isSystemUser);
}
export function projectFor(
  state: State,
  projectId: string,
  userId: string,
  permission: boolean | ProjectPermission = false,
): StoredProject {
  const project = state.projects.find((p) => p.id === projectId);
  assert(
    project && canAccess(project, userId),
    404,
    "Project not found.",
  );
  assert(
    !permission || (permission === true ? roleFor(project, userId) === "admin" : hasProjectPermission(project, userId, permission)),
    403,
    "The required project permission is missing.",
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
export function membersFor(state: State, project: StoredProject, viewerId?: string): Member[] {
  return state.users
    .filter((u) => !!project.roles[u.id] && (!u.isSystemUser || !viewerId || state.users.some(user => user.id === viewerId && user.isSystemUser)))
    .map((u) => ({
      ...publicUser(u),
      role: project.roles[u.id],
      permissions: projectPermissions(project, u.id),
    }));
}
export async function sessionData(state: State, user: StoredUser, client?: DatabaseClient): Promise<SessionData> {
  const limits = await concurrencySettings(client);
  return {
    user: publicUser(user),
    canCreateProjects: canCreateProjects(state, user.id),
    projects: await Promise.all(state.projects
      .filter((p) => canAccess(p, user.id))
      .map(p => publicProject(p, client, limits.get(p.id) ?? DEFAULT_MAX_CONCURRENT_RUNS, { state, userId: user.id }))),
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
  return state.tickets.some(ticket => ticket.projectId === project.id && ticket.status === "active");
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
