export const DEFAULT_MAX_CONCURRENT_RUNS = 100;
export const DEFAULT_E2B_TEMPLATE = "claude";
export type Role = "admin" | "member";
export type ProjectPermission = "analytics" | "peopleRead" | "peopleWrite" | "workflowWrite" | "generalRead" | "generalWrite" | "sandboxRead" | "sandboxWrite";
export type ModelProvider = "ollama" | "claude";
export type SandboxProvider = "docker" | "e2b";
export type RunStatus = "pending" | "running" | "completed" | "failed";
export interface User {
  id: string;
  name: string;
  email: string;
  mustChangePassword: boolean;
  isSystemUser?: boolean;
}
export interface Member extends User {
  role: Role;
  permissions?: ProjectPermission[];
}
export interface Step {
  id: string;
  name: string;
  kind: "parking" | "manual" | "definition" | "implement";
  instructions: string;
  model: string;
  requiredApprovals: number;
  approverIds: string[];
  hiddenApproverCount?: number;
  includePriorArtifacts: boolean;
  filename: string;
}
export interface Project {
  id: string;
  name: string;
  key: string;
  description: string;
  repository: string;
  baseBranch: string;
  model: string;
  modelProvider: ModelProvider;
  sandboxProvider: SandboxProvider;
  maxConcurrentRuns: number;
  dockerImage: string;
  e2bTemplate: string;
  steps: Step[];
  roles: Record<string, Role>;
  memberPermissions?: Record<string, ProjectPermission[]>;
  permissionVersion?: 2;
  analyticsMemberIds?: string[];
  githubConnected: boolean;
  githubIdentity: string;
  hasOllamaKey: boolean;
  hasClaudeKey: boolean;
  hasE2bKey: boolean;
}
export interface TicketAttachment {
  id: string;
  filename: string;
  contentType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "text/markdown";
  size: number;
}
export type TicketAttachmentInput =
  | { id: string }
  | {
      filename: string;
      contentType: TicketAttachment["contentType"];
      data: string;
    };
export interface TicketPullRequest {
  stepId: string;
  runId: string;
  number: number;
  url: string;
}
export interface Ticket {
  id: string;
  projectId: string;
  number: string;
  title: string;
  description: string;
  attachments: TicketAttachment[];
  workflowSnapshot: Step[] | null;
  priority: "low" | "medium" | "high" | "urgent";
  status: "backlog" | "active" | "closed";
  stepId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  startedAt?: string | null;
  pullRequests: TicketPullRequest[];
}
export interface Artifact {
  id: string;
  ticketId: string;
  stepId: string;
  filename: string;
  content: string;
  version: number;
  updatedAt: string;
  updatedBy: string;
}
export interface Approval {
  id: string;
  ticketId: string;
  stepId: string;
  userId: string;
  anonymous?: boolean;
  createdAt: string;
}
export interface Thread {
  id: string;
  ticketId: string;
  stepId: string;
  title: string;
  createdBy: string;
  createdAt: string;
}
export interface Message {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "system";
  authorId: string | null;
  content: string;
  createdAt: string;
}
export interface Run {
  id: string;
  projectId: string;
  ticketId: string;
  stepId: string;
  threadId: string | null;
  kind: "definition" | "chat" | "implement";
  noChanges?: boolean;
  status: RunStatus;
  cleanupStatus: "none" | "pending" | "complete";
  logSealed: boolean;
  eligibleAt?: string;
  attempts?: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface AuditEvent {
  id: string;
  projectId: string;
  ticketId: string | null;
  userId: string | null;
  action: string;
  detail: string;
  createdAt: string;
}
export interface ProjectData {
  project: Project;
  members: Member[];
  tickets: Ticket[];
  artifacts: Artifact[];
  approvals: Approval[];
  threads: Thread[];
  messages: Message[];
  runs: Run[];
  audit: AuditEvent[];
  workflowLocked: boolean;
}
export interface SessionData {
  user: User;
  canCreateProjects: boolean;
  projects: Project[];
}
export interface RunContext {
  run: Run;
  project: Project;
  ticket: Ticket;
  step: Step;
  artifacts: Artifact[];
  attachments: Array<TicketAttachment & { data: string }>;
  messages: Message[];
  credentials: { githubToken: string; ollamaApiKey: string; claudeApiKey: string; e2bApiKey: string };
}
export interface RunResult {
  reply: string;
  artifact?: string;
  prNumber?: number;
  prUrl?: string;
  noChanges?: boolean;
}

export interface TicketDetailData {
  ticket: Ticket;
  artifacts: Artifact[];
  approvals: Approval[];
  threads: Thread[];
  messages: Message[];
  runs: Run[];
  audit: AuditEvent[];
  nextRunsCursor: string | null;
  nextAuditCursor: string | null;
  runsPageOldest: HistoryBoundary | null;
  auditPageOldest: HistoryBoundary | null;
}
export interface HistoryBoundary {
  id: string;
  createdAt: string;
}
export interface RunLogData {
  tail?: string;
  version: number;
  unchanged: boolean;
  sealed: boolean;
}

export interface AnalyticsData {
  summary: {
    completedTickets: number;
    averageWeeklyCloseRate: number;
    averageCycleMs: number | null;
    medianCycleMs: number | null;
    averageLeadMs: number | null;
    activeTickets: number;
    averageActiveAgeMs: number | null;
  };
  closeRatePeriod: { startedAt: string; endedAt: string; weeks: number; completedTickets: number };
  priorityCounts: Array<{ priority: Ticket["priority"]; backlog: number; active: number; total: number }>;
  completedTickets: Array<{
    id: string; number: string; title: string;
    createdAt: string; startedAt: string | null; closedAt: string;
    cycleMs: number | null; leadMs: number | null;
  }>;
  activeTickets: Array<{
    id: string; number: string; title: string;
    startedAt: string | null; ageMs: number | null;
  }>;
}
