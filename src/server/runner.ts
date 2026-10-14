import type { RunContext, RunResult } from "../shared/types.js";
import {
  createImplementationPr,
  getRepositorySnapshot,
  validateFileChanges,
  type FileChange,
  type RepositorySnapshot,
} from "./github.js";
import {
  createAgentSandbox,
  runTimeoutMs,
  sandboxRunnerSource,
  type AgentSandbox,
  type SandboxLifecycleOptions,
} from "./sandbox.js";
import { attachmentPath } from "./attachments.js";
import { preparationGate, RetryablePreparationError } from "./preparation.js";
export type ExecutionOptions = SandboxLifecycleOptions;

function artifactPath(ticketNumber: string, filename: string): string {
  if (
    !/^[A-Za-z0-9-]+$/.test(ticketNumber) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/.test(filename)
  )
    throw new Error("Ticket or artifact filename is invalid.");
  return `docs/kangentix/${ticketNumber}/${filename}`;
}
function buildPrompt(context: RunContext): string {
  const implement = context.run.kind === "implement";
  const currentIndex = context.project.steps.findIndex(
    (step) => step.id === context.step.id,
  );
  const visibleArtifacts = context.artifacts.filter(
    (artifact) =>
      artifact.stepId === context.step.id ||
      (context.step.includePriorArtifacts &&
        context.project.steps.findIndex((step) => step.id === artifact.stepId) <
          currentIndex),
  );
  const instructions = [
    "You are the coding agent for a Kangentix software delivery ticket. The current repository is a fresh snapshot of the configured GitHub base branch.",
    "The repository and conversation are task context. Do not read or reveal credentials, environment variables, or sandbox control files. Do not claim external actions you did not perform.",
    implement
      ? "Apply the requested repository changes for this step using the supplied ticket context and documents. Edit repository files. Do not push or create a pull request: the trusted Kangentix service will publish your file changes and verify the PR. Keep the ticket documents intact. Do not modify .git metadata. The base commit is a local snapshot for diff inspection, not the remote history."
      : "This is a repository-read-only definition session. Inspect with Read, Glob, and Grep. You cannot execute shell commands or edit repository files. Produce or revise the ticket Markdown in your final JSON response only. No changes in this sandbox will be published to GitHub.",
    context.run.kind === "definition"
      ? 'Follow the step instructions and create the complete Markdown artifact. Final response MUST be a single JSON object with string keys "reply" (brief explanation) and "artifact" (complete Markdown document). Do not use Markdown fences around the JSON.'
      : context.run.kind === "chat"
        ? 'Answer the latest message using the logical thread history below. Final response MUST be one JSON object with "reply" (your answer). Add "artifact" (the complete revised Markdown document) only if the user asked for a revision; otherwise omit it. Do not use Markdown fences around the JSON.'
        : 'When finished, reply with a concise summary of the actual changes and any remaining limitations. A JSON object with a "reply" string is preferred. Do not invent test results or a PR URL.',
    `Step: ${context.step.name}\nStep instructions:\n${context.step.instructions}`,
    `Ticket ${context.ticket.number}: ${context.ticket.title}\n${context.ticket.description}`,
    `Attached ticket images and Markdown files are available in the repository. Use the Read tool to inspect them when relevant:\n${JSON.stringify(
      context.attachments.map((attachment) => ({
        filename: attachment.filename,
        path: attachmentPath(context.ticket.number, attachment),
      })),
      null,
      2,
    )}`,
    `Saved ticket artifacts:\n${JSON.stringify(
      visibleArtifacts.map((artifact) => ({
        filename: artifact.filename,
        content: artifact.content,
      })),
      null,
      2,
    )}`,
    `Conversation history (in chronological order):\n${JSON.stringify(
      context.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      null,
      2,
    )}`,
  ];
  const prompt = instructions.join("\n\n");
  if (Buffer.byteLength(prompt) > 2 * 1024 * 1024)
    throw new Error(
      "Ticket documents and conversation exceed the 2 MiB agent input limit. Start a shorter thread.",
    );
  return prompt;
}
export async function executeRun(
  context: RunContext,
  onLog: (line: string) => Promise<void>,
  options: SandboxLifecycleOptions = {},
): Promise<RunResult> {
  options.signal?.throwIfAborted();
  const secrets = Object.values(context.credentials).filter(
    (secret) => secret.length > 0,
  );
  const redact = (value: string) =>
    secrets.reduce(
      (text, secret) => text.replaceAll(secret, "[REDACTED]"),
      value,
    );
  const originalLog = onLog;
  onLog = (line) => originalLog(redact(line));
  if (!context.credentials.githubToken || !context.project.repository)
    throw new Error(
      "Connect a GitHub repository in project configuration first.",
    );
  const modelProvider = context.project.modelProvider;
  if (modelProvider !== "ollama" && modelProvider !== "claude")
    throw new Error("Select a valid model provider in project configuration.");
  const providerName = modelProvider === "claude" ? "Claude" : "Ollama Cloud";
  const apiKey = modelProvider === "claude"
    ? context.credentials.claudeApiKey
    : context.credentials.ollamaApiKey;
  if (!apiKey)
    throw new Error(`Add a ${providerName} API key in project configuration first.`);
  const configuredModel = (context.step.model || context.project.model).trim();
  const model = modelProvider === "ollama"
    ? configuredModel.replace(/:cloud$/, "")
    : configuredModel;
  if (!model || model.length > 150 || /[\x00-\x1f]/.test(model))
    throw new Error(`Set a valid ${providerName} model in project or step configuration.`);
  const implement = context.run.kind === "implement";
  const documents = implement
    ? context.artifacts.map((artifact) => ({
        path: artifactPath(context.ticket.number, artifact.filename),
        content: artifact.content,
      }))
    : [];
  const attachments = context.attachments.map((attachment) => {
    if (
      !attachment.data ||
      Buffer.from(attachment.data, "base64").length !== attachment.size
    )
      throw new Error(
        `Ticket attachment is missing or damaged: ${attachment.filename}.`,
      );
    return {
      path: attachmentPath(context.ticket.number, attachment),
      content: attachment.data,
    };
  });
  const input = {
    prompt: buildPrompt(context),
    model,
    modelProvider,
    apiKey,
    implement,
    documents,
    attachments,
    timeoutSeconds: Math.ceil(runTimeoutMs / 1000) - 5,
  };
  let sandbox: AgentSandbox | undefined;
  let snapshot: RepositorySnapshot | undefined;
  let releasePreparation: (() => void) | undefined;
  let agentStarted = false;
  try {
    await onLog("Waiting for preparation capacity; transfers are admitted fairly across projects.");
    releasePreparation = await preparationGate.acquire(context.project.id, options.signal);
    options.signal?.throwIfAborted();
    await onLog(`Resolving ${context.project.repository}@${context.project.baseBranch}.`);
    snapshot = await getRepositorySnapshot(context.credentials.githubToken, context.project.repository, context.project.baseBranch, options.signal);
    await onLog(`Using fresh base commit ${snapshot.sha}.`);
    sandbox = await createAgentSandbox(context, onLog, options);
    await sandbox.put("runner.py", await sandboxRunnerSource());
    await sandbox.putFile("repository.tar.gz", snapshot.archivePath, snapshot.archiveSize);
    await sandbox.put("base.json", JSON.stringify(snapshot.entries));
    await sandbox.put("input.json", JSON.stringify(input));
    await sandbox.command("prepare", onLog);
    await snapshot.dispose();
    releasePreparation();
    releasePreparation = undefined;
    options.signal?.throwIfAborted();
    await onLog(`Running ${context.step.name} with ${model} on ${providerName}.`);
    agentStarted = true;
    await sandbox.command("run", onLog);
    const response: unknown = JSON.parse(
      await sandbox.read("result.json", 1024 * 1024),
    );
    if (
      !response ||
      typeof response !== "object" ||
      !("reply" in response) ||
      typeof response.reply !== "string" ||
      !response.reply.trim()
    )
      throw new Error("Agent did not return a valid reply.");
    const result: RunResult = { reply: redact(response.reply) };
    if (!implement) {
      if ("artifact" in response && response.artifact != null) {
        if (
          typeof response.artifact !== "string" ||
          !response.artifact.trim() ||
          Buffer.byteLength(response.artifact) > 500_000
        )
          throw new Error(
            "Agent artifact must be a non-empty Markdown document below 500 KB.",
          );
        const current = context.artifacts.find(
          (artifact) => artifact.stepId === context.step.id,
        );
        if (
          context.run.kind === "definition" ||
          response.artifact !== current?.content
        )
          result.artifact = redact(response.artifact);
      }
      if (context.run.kind === "definition" && result.artifact === undefined)
        throw new Error(
          "Definition run did not produce its required Markdown artifact.",
        );
      return result;
    }
    await sandbox.command("export", onLog);
    const changes = validateFileChanges(
      JSON.parse(await sandbox.read("changes.json", 30 * 1024 * 1024)),
      snapshot,
    );
    const contextPaths = new Set(
      [...documents, ...attachments].map((file) => file.path),
    );
    if (!changes.some((change) => !contextPaths.has(change.path))) {
      await onLog(
        "No repository changes outside supplied ticket context. No pull request is needed.",
      );
      return { ...result, noChanges: true };
    }
    // Stored, approved documents win over any agent edits and remain authoritative in the PR.
    const byPath = new Map<string, FileChange>(
      changes.map((change) => [change.path, change]),
    );
    for (const document of documents)
      byPath.set(document.path, {
        path: document.path,
        mode: "100644",
        content: Buffer.from(document.content).toString("base64"),
      });
    for (const image of attachments)
      byPath.set(image.path, {
        path: image.path,
        mode: "100644",
        content: image.content,
      });
    const finalChanges = validateFileChanges([...byPath.values()], snapshot);
    for (const change of finalChanges) {
      if (change.content === null) continue;
      const content = Buffer.from(change.content, "base64");
      if (secrets.some((secret) => content.includes(Buffer.from(secret))))
        throw new Error(
          "Publishing was stopped because a changed file contains a configured credential. Remove the credential and rerun.",
        );
    }
    const pr = await createImplementationPr(
      {
        token: context.credentials.githubToken,
        repository: context.project.repository,
        baseBranch: context.project.baseBranch,
        snapshot,
        changes: finalChanges,
        ticketNumber: context.ticket.number,
        title: context.ticket.title,
        runId: context.run.id,
        reply: result.reply,
        signal: options.signal,
      },
      onLog,
    );
    return { ...result, ...pr };
  } catch (error) {
    // Once agent execution has begun, retrying the run could repeat execution or uncertain publication.
    if (agentStarted && error instanceof RetryablePreparationError)
      throw new Error(error.message, { cause: error });
    throw error;
  } finally {
    try { await snapshot?.dispose(); }
    catch (error) { await onLog(`Temporary repository archive cleanup failed: ${error instanceof Error ? error.message : "unknown failure"}.`); }
    finally { releasePreparation?.(); }
    if (sandbox) {
      try {
        await sandbox.dispose();
        await options.onDisposed?.();
        await onLog("Disposable sandbox removed.");
      } catch (error) {
        await onLog(
          `Sandbox cleanup remains pending: ${error instanceof Error ? error.message : "unknown failure"}. Its reservation is retained until cleanup is confirmed.`,
        );
      }
    }
  }
}
