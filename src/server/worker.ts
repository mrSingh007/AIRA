import { current, isDraft } from "immer";
import { DEFAULT_MAX_CONCURRENT_RUNS, type Run, type RunContext, type RunResult } from "../shared/types.js";
import { mutate, pool } from "./db.js";
import { executeRun, type ExecutionOptions } from "./runner.js";
import { discoverOwnedSandboxes, disposeOwnedSandbox, type SandboxResource } from "./sandbox.js";
import { decrypt, redact } from "./security.js";
import { assert, audit, id, now, publicProject, writeArtifact } from "./state.js";
import { claimRun, getRun, listRuns, listLifecycles, reservationCounts, setLifecycle, updateRun,
  recoverInterruptedRuns as interruptStoredRuns } from "./run-repository.js";
import { concurrencySettings } from "./project-agent-settings.js";
import { openRunLog, flushRunLogs } from "./run-logs.js";
import { fairAdmissions } from "./scheduler.js";
import { credentialScope, providerCooldown, recordProviderCooldown, retryDelay, RetryablePreparationError } from "./preparation.js";

type Claim = RunContext & { cleanupCredential: string };
interface ActiveRun {
  projectId: string; runId: string; ticketId: string; controller: AbortController;
  promise: Promise<void>; phase: string;
}
const active = new Map<string, ActiveRun>();

let stopped = true;
let pumping: Promise<void> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let cursor: string | undefined;
let cleanupPromise: Promise<void> | undefined;
let execute: typeof executeRun = executeRun;
let pollMs = 1000;
let wakeRequested = false;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function recoverInterruptedRuns() {
  await mutate(async (state, client) => {
    const interrupted = await interruptStoredRuns(client);
    for (const run of interrupted) {
      audit(state, run.projectId, run.ticketId, null, "run.interrupted", run.error!);
      if (run.threadId) state.messages.push({ id: id(), threadId: run.threadId, role: "system",
        authorId: null, content: run.error!, createdAt: now() });
    }
    state.sessions = state.sessions.filter((session) => session.expiresAt > now());
  });
  // Durable reservations are queried before every claim. Restore/reconcile ownership
  // before starting the pump; pending jobs remain pending.
  let startupDeadline: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    reconcileCleanup(true).catch(() => console.error("Startup cleanup remains reserved for background recovery.")),
    new Promise<void>((resolve) => { startupDeadline = setTimeout(resolve, 5000); }),
  ]);
  if (startupDeadline) clearTimeout(startupDeadline);
}
function detachClaimValue(value: any): any {
  if (isDraft(value)) return current(value);
  if (Array.isArray(value)) return value.map(detachClaimValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,detachClaimValue(item)]));
  return value;
}
export async function claimAvailableRuns(): Promise<Claim[]> {
  // Idle polls need neither a full workflow snapshot clone nor the state lock.
  const eligible = await pool.query("SELECT 1 FROM aira_runs WHERE status='pending' AND eligible_at <= now() LIMIT 1");
  if (!eligible.rowCount) return [];
  let nextCursor = cursor;
  let staged: Claim[] = [];
  let claims: Claim[];
  try {
  claims = await mutate(async (state, client) => {
    const limits = await concurrencySettings(client);
    const reservations = await reservationCounts(client);
    const queues = new Map<string, Run[]>();
    for (const project of state.projects) {
      const runs = await listRuns({ projectId: project.id, status: "pending", eligible: true, limit: 32 }, client);
      if (!runs.length) continue;
      try {
        if (providerCooldown(credentialScope("github", decrypt(project.secrets.githubToken))) ||
          (project.sandboxProvider === "e2b" && providerCooldown(credentialScope("e2b", decrypt(project.secrets.e2bApiKey))))) continue;
      } catch { /* Claim and fail invalid encrypted credentials individually below. */ }
      queues.set(project.id, runs);
      if (!limits.has(project.id)) limits.set(project.id, DEFAULT_MAX_CONCURRENT_RUNS);
    }
    const selection = fairAdmissions(queues, limits, reservations, cursor);
    nextCursor = selection.lastProject;
    const result: Claim[] = [];
    for (const run of selection.admitted) {
      const ticket = state.tickets.find((item) => item.id === run.ticketId);
      const project = state.projects.find((item) => item.id === run.projectId);
      const step = project?.steps.find((item) => item.id === run.stepId);
      if (!ticket || !project || !step || ticket.status !== "active" || ticket.stepId !== step.id ||
          (step.kind !== "definition" && step.kind !== "implement")) {
        run.status = "failed"; run.error = "The ticket or workflow changed before this run could start.";
        run.finishedAt = now();
        await updateRun(run, client);
        await client.query("UPDATE aira_run_logs SET sealed=true,version=version+1 WHERE run_id=$1", [run.id]);
        continue;
      }
      if (!await claimRun(run.id, project.sandboxProvider, client)) continue;
      run.status = "running"; run.startedAt = now();
      audit(state, project.id, ticket.id, null, "run.started", `${run.kind} execution started.`);
      const index = project.steps.findIndex((item) => item.id === step.id);
      const prior = new Set(project.steps.slice(0, index + 1).map((item) => item.id));
      let credentials: RunContext["credentials"];
      try {
        credentials = { githubToken: decrypt(project.secrets.githubToken),
          ollamaApiKey: decrypt(project.secrets.ollamaApiKey), claudeApiKey: decrypt(project.secrets.claudeApiKey), e2bApiKey: decrypt(project.secrets.e2bApiKey) };
      } catch {
        run.status = "failed"; run.finishedAt = now(); run.error = "Project credentials could not be decrypted; update project configuration.";
        await updateRun(run, client);
        await setLifecycle(run.id, { reservationHeld: false, phase: "settled" }, client);
        await client.query("UPDATE aira_run_logs SET sealed=true,version=version+1 WHERE run_id=$1", [run.id]);
        continue;
      }
      result.push({ run, ticket, step, project: await publicProject(project, client), credentials,
        cleanupCredential: project.sandboxProvider === "e2b" ? project.secrets.e2bApiKey : "",
        artifacts: state.artifacts.filter((artifact) => artifact.ticketId === ticket.id &&
          (artifact.stepId === step.id || (step.includePriorArtifacts && prior.has(artifact.stepId)))),
        attachments: ticket.attachments.map((attachment) => ({ ...attachment, data: state.attachmentData[attachment.id] })),
        messages: run.threadId ? state.messages.filter((message) => message.threadId === run.threadId) : [] });
    }
    // Keep the original execution snapshot outside the transaction before COMMIT.
    // A lost acknowledgement must not discard successfully reserved work.
    staged = result.map(detachClaimValue);
    return staged;
  });
  } catch (error) {
    if (!staged.length) throw error;
    claims = [];
    await retryPersistence(async () => {
      const persisted = await pool.query("SELECT id,status,phase,project_id,provider FROM aira_runs WHERE id=ANY($1::text[]) FOR UPDATE", [staged.map(claim => claim.run.id)]);
      const byId = new Map(persisted.rows.map(row => [row.id,row]));
      claims = staged.filter(claim => {
        const row = byId.get(claim.run.id);
        return row?.status === "running" && row.phase === "preparing" && row.project_id === claim.project.id && row.provider === claim.project.sandboxProvider;
      });
    });
    // Pending rows mean the claim rolled back; leave them for a fresh later claim.
  }
  cursor = nextCursor;
  return claims;
}
function validateResult(claim: Claim, result: RunResult) {
  assert(typeof result.reply === "string" && result.reply.length <= 500_000, 502, "The agent did not return a valid response below 500 KB.");
  if (claim.run.kind === "definition") assert(typeof result.artifact === "string" && result.artifact.trim(), 502, "The definition run did not produce a Markdown document.");
  if (result.artifact !== undefined) assert(typeof result.artifact === "string" && result.artifact.length <= 500_000, 502, "The generated document exceeded the 500 KB limit.");
  if (claim.run.kind === "implement") assert(result.noChanges === true ||
    (Number.isInteger(result.prNumber) && (result.prNumber || 0) > 0 && result.prUrl === `https://github.com/${claim.project.repository}/pull/${result.prNumber}`),
    502, `${claim.step.name} did not return a verified GitHub pull request or a confirmed no-change result.`);
}
async function persistOutcome(claim: Claim, result: RunResult | undefined, error: string | undefined) {
  await mutate(async (state, client) => {
    const run = await getRun(claim.run.id, client);
    if (!run || run.status !== "running") return; // replay after a lost COMMIT acknowledgement
    const ticket = state.tickets.find((item) => item.id === claim.ticket.id);
    if (result && ticket) {
      if (result.artifact !== undefined && run.kind !== "implement") writeArtifact(state, ticket, claim.step, result.artifact, "agent");
      if (run.threadId) state.messages.push({ id: id(), threadId: run.threadId, role: "assistant", authorId: null, content: result.reply, createdAt: now() });
      if (run.kind === "implement") {
        run.noChanges = result.noChanges === true;
        if (run.noChanges) audit(state, run.projectId, ticket.id, null, "pull_request.skipped", `${claim.step.name} completed with no repository changes.`);
        else {
          ticket.pullRequests.push({ stepId: run.stepId, runId: run.id, number: result.prNumber!, url: result.prUrl! });
          audit(state, run.projectId, ticket.id, null, "pull_request.created", `PR #${result.prNumber}: ${result.prUrl}.`);
        }
      }
      ticket.updatedAt = now();
    } else if (run.threadId) state.messages.push({ id: id(), threadId: run.threadId, role: "system", authorId: null,
      content: `Execution failed: ${error}`, createdAt: now() });
    run.status = result ? "completed" : "failed"; run.finishedAt = now(); run.error = error || null;
    await updateRun(run, client);
    audit(state, run.projectId, run.ticketId, null, result ? "run.completed" : "run.failed", error || `${run.kind} execution completed.`);
  });
}
async function retryPersistence(fn: () => Promise<void>) {
  let backoff = 250;
  for (;;) {
    try { await fn(); return; }
    catch (error) { console.error("Run finalization awaiting database recovery; execution will not be repeated.", error instanceof Error ? error.name : "unknown", typeof error === "object" && error && "code" in error ? error.code : "");
      await delay(backoff); backoff = Math.min(10_000, backoff * 2); }
  }
}
async function runClaim(claim: Claim, record: ActiveRun) {
  const secrets = Object.values(claim.credentials);
  const log = await openRunLog(claim.run.id, secrets);
  let created = false;
  let disposed = false;
  let result: RunResult | undefined;
  let failure: string | undefined;
  let retryError: { scope: string; retryAfterMs: number } | undefined;
  const options: ExecutionOptions = {
    signal: record.controller.signal,
    onCreating: async (provider, expiresAt) => {
      await setLifecycle(claim.run.id, { provider, phase: "creating", expiresAt,
        cleanupCredential: claim.cleanupCredential, reservationHeld: true });
      created = true;
    },
    onCreated: async (resource) => {
      await setLifecycle(claim.run.id, { provider: resource.provider, sandboxId: resource.id,
        expiresAt: resource.expiresAt, phase: "executing", reservationHeld: true });
      record.phase = "executing";
    },
    onDisposed: async () => {
      disposed = true;
      await setLifecycle(claim.run.id, { sandboxId: null, cleanupCredential: null, phase: "finalizing" });
    },
  };
  try {
    record.controller.signal.throwIfAborted();
    await log.write(`Starting ${claim.run.kind} with ${claim.project.sandboxProvider}; model ${claim.step.model || claim.project.model}.`);
    record.controller.signal.throwIfAborted();
    result = await execute(claim, log.write, options);
    validateResult(claim, result);
    result = { ...result, reply: redact(result.reply, secrets), artifact: result.artifact === undefined ? undefined : redact(result.artifact, secrets) };
    await log.write(`${result.reply}\nExecution completed.`);
  } catch (error) {
    result = undefined;
    failure = redact(error instanceof Error ? error.message : "Unknown agent execution error.", secrets).slice(0, 4000);
    if ((!created || disposed) && !stopped && error instanceof RetryablePreparationError)
      retryError = { scope: error.scope, retryAfterMs: retryDelay(claim.run.attempts || 0, error.retryAfterMs) };
    await log.write(`Failed: ${failure}`);
  }
  record.phase = "finalizing";
  await retryPersistence(async () => {
    await log.flush();
    if (retryError && (claim.run.attempts || 0) < 3) {
      await mutate(async (_state, client) => {
        const run = await getRun(claim.run.id, client);
        if (!run || run.status !== "running") return;
        run.status = "pending"; run.startedAt = null; run.attempts = (run.attempts || 0) + 1;
        run.eligibleAt = new Date(Date.now() + retryError!.retryAfterMs).toISOString();
        run.error = `Waiting for provider capacity: ${failure}`;
        await updateRun(run, client);
        await setLifecycle(run.id, { reservationHeld: false, phase: "queued", cleanupCredential: null }, client);
      });
      recordProviderCooldown(new RetryablePreparationError(failure!, retryError.scope, retryError.retryAfterMs));
    } else {
      await persistOutcome(claim, result, failure);
      const cleanupPending = created && !disposed;
      if (cleanupPending) {
        await setLifecycle(claim.run.id, { reservationHeld: true, phase: "cleanup" });
      } else {
        // The durable seal and release are one boundary. A crash cannot leave an
        // unreserved terminal run with a log stream that never becomes sealed.
        await mutate(async (_state, client) => {
          await setLifecycle(claim.run.id, { reservationHeld: false, phase: "settled", sandboxId: null, cleanupCredential: null, nextCleanupAt: null }, client);
          await client.query("UPDATE aira_run_logs SET sealed=true,version=version+1 WHERE run_id=$1 AND NOT sealed", [claim.run.id]);
        });
        await log.seal();
      }
    }
  });
}
async function reconcileCleanup(startup = false) {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = reconcileCleanupRecords(startup).finally(() => { cleanupPromise = undefined; });
  return cleanupPromise;
}
async function reconcileCleanupRecords(startup = false) {
  for (const lifecycle of await listLifecycles()) {
    if (!lifecycle.reservationHeld || active.has(lifecycle.runId)) continue;
    const run = await getRun(lifecycle.runId);
    if (!run || run.status === "pending" || (!startup && run.status === "running")) continue;
    if (lifecycle.nextCleanupAt && lifecycle.nextCleanupAt > now()) continue;
    const log = await openRunLog(run.id);
    let credential = "";
    try {
      credential = decrypt(lifecycle.cleanupCredential || "");
      let settled = lifecycle.phase === "preparing" || lifecycle.phase === "settled" || lifecycle.phase === "finalizing";
      if (!settled && lifecycle.provider) {
        const resources: SandboxResource[] = lifecycle.sandboxId
          ? [{ provider: lifecycle.provider, id: lifecycle.sandboxId, expiresAt: lifecycle.expiresAt! }]
          : await discoverOwnedSandboxes(run.projectId, run.id, lifecycle.provider, credential);
        for (const resource of resources) await disposeOwnedSandbox(resource, credential);
        settled = resources.length > 0 || (lifecycle.provider === "e2b" && !!lifecycle.expiresAt && lifecycle.expiresAt <= now()) || lifecycle.provider === "docker";
      }
      if (settled) {
        await log.write("Sandbox cleanup confirmed; project capacity released.");
        await log.flush();
        await mutate(async (_state, client) => {
          await setLifecycle(run.id, { reservationHeld: false, phase: "settled", sandboxId: null, cleanupCredential: null, nextCleanupAt: null }, client);
          await client.query("UPDATE aira_run_logs SET sealed=true,version=version+1 WHERE run_id=$1 AND NOT sealed", [run.id]);
        });
        await log.seal();
      } else throw new Error("Resource creation was uncertain; awaiting ownership discovery or lifetime expiry.");
    } catch (error) {
      // A committed settlement whose acknowledgement was lost is already final.
      const persisted = await getRun(run.id);
      if (persisted?.logSealed && persisted.cleanupStatus === "complete") {
        await log.seal();
        continue;
      }
      const attempt = (lifecycle.cleanupAttempts || 0) + 1;
      await log.write(`Cleanup pending: ${redact(error instanceof Error ? error.message : "provider unavailable", [credential])}`);
      await setLifecycle(run.id, { phase: "cleanup", cleanupAttempts: attempt,
        nextCleanupAt: new Date(Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6))).toISOString() });
    }
  }
}
export function wakeWorker() {
  if (stopped) return;
  if (pumping) { wakeRequested = true; return; }
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { void pump(); }, 0);
}
async function pump() {
  if (stopped) return;
  if (pumping) return pumping;
  pumping = (async () => {
    try {
      void reconcileCleanup().catch(() => console.error("Cleanup recovery awaiting database connectivity."));
      for (let batch = 0; batch < 16 && !stopped; batch++) {
        const claims = await claimAvailableRuns();
        for (const claim of claims) {
          const record: ActiveRun = { projectId: claim.project.id, runId: claim.run.id, ticketId: claim.ticket.id,
            controller: new AbortController(), promise: Promise.resolve(), phase: "preparing" };
          if (stopped) record.controller.abort(new Error("Shutdown stopped this claim before dispatch."));
          active.set(claim.run.id, record);
          record.promise = runClaim(claim, record).catch(async () => {
            // Includes failure to initialize logging; fail without ever executing again.
            await retryPersistence(async () => {
              await persistOutcome(claim, undefined, "Execution could not initialize or persist its lifecycle. Review before retrying.");
              // Ownership remains reserved until the cleanup reconciler confirms it.
            });
          }).finally(() => { active.delete(claim.run.id); wakeWorker(); });
        }
        if (claims.length < 32) break;
      }
    } catch { console.error("Scheduler awaiting database recovery."); }
  })().finally(() => {
    pumping = undefined;
    if (!stopped) { if (timer) clearTimeout(timer); timer = setTimeout(() => { void pump(); }, wakeRequested ? 0 : pollMs); wakeRequested = false; }
  });
  return pumping;
}
export function startWorker(options: { execute?: typeof executeRun; pollMs?: number } = {}) {
  execute = options.execute || executeRun; pollMs = options.pollMs || 1000;
  stopped = false; wakeWorker();
}
export function workerActivity() { return [...active.values()].map(({ projectId, runId, ticketId, phase }) => ({ projectId, runId, ticketId, phase })); }
export async function stopWorker(drainMs = 20_000) {
  stopped = true;
  if (timer) clearTimeout(timer);
  await pumping;
  const drain = Promise.allSettled([...active.values()].map((record) => record.promise));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([drain, new Promise<void>((resolve) => { deadline = setTimeout(resolve, drainMs); })]);
  if (deadline) clearTimeout(deadline);
  for (const record of active.values()) record.controller.abort(new Error("Application shutdown cancelled this execution."));
  await Promise.allSettled([...active.values()].map((record) => record.promise));
  await reconcileCleanup();
  await flushRunLogs();
}
