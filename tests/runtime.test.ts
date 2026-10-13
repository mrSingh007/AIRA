import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname } from "node:path";
import { AuthenticationError, RateLimitError, Sandbox, ServiceBusyError } from "@e2b/code-interpreter";
import type { RunContext } from "../src/shared/types.js";
import { boundedArchive, getRepositorySnapshot } from "../src/server/github.js";
import { createAgentSandbox, discoverOwnedSandboxes, e2bControlPlane, E2BCreationRefusedError, lineOutput, sandboxOwnerId } from "../src/server/sandbox.js";
import { executeRun } from "../src/server/runner.js";
import { FairPreparationGate, credentialScope, providerCooldown, RetryablePreparationError, retryDelay, throttledResponse } from "../src/server/preparation.js";

const context = (): RunContext => ({
  run: { id: "run-1", kind: "definition" },
  project: { id: "project-1", sandboxProvider: "e2b", modelProvider: "ollama", e2bTemplate: "base", repository: "owner/repo", baseBranch: "main", model: "model", steps: [] },
  step: { id: "step-1", name: "Define", instructions: "Write the definition", model: "" },
  ticket: { number: "AIRA-1", title: "Task", description: "Context" },
  artifacts: [], attachments: [], messages: [],
  credentials: { githubToken: "github-secret", claudeApiKey: "contract-claude-secret", ollamaApiKey: "ollama-secret", e2bApiKey: "e2b-secret" },
} as unknown as RunContext);
const log = async (_line: string) => {};
function mockE2BSandbox(t: TestContext, factory: (...args: any[]) => Promise<any>) {
  let sandbox: any;
  const create = t.mock.method(e2bControlPlane, "create", async (...args: any[]) => {
    sandbox = await factory(...args); return sandbox.sandboxId;
  });
  const connect = t.mock.method(Sandbox, "connect", async () => sandbox);
  return { restore() { create.mock.restore(); connect.mock.restore(); } };
}


test("preparation admission is bounded, round-robin, cancellable, and idempotently released", async () => {
  const gate = new FairPreparationGate(1);
  const first = await gate.acquire("A");
  const order: string[] = [];
  const a2 = gate.acquire("A").then((release) => { order.push("A2"); release(); });
  const a3 = gate.acquire("A").then((release) => { order.push("A3"); release(); });
  const b1 = gate.acquire("B").then((release) => { order.push("B1"); release(); });
  const controller = new AbortController();
  const cancelled = gate.acquire("C", controller.signal);
  controller.abort(new Error("cancelled"));
  await assert.rejects(cancelled, /cancelled/);
  assert.equal(gate.occupancy, 1);
  assert.equal(gate.waiting, 3);
  first(); first();
  await Promise.all([a2, a3, b1]);
  assert.deepEqual(order, ["A2", "B1", "A3"]);
  assert.equal(gate.occupancy, 0);
});

test("bounded output awaits persistence, preserves lines, and reports failures", async () => {
  const lines: string[] = [];
  const output = lineOutput(async (line) => { lines.push(line); });
  await output.write("first\nse", "stdout");
  await output.write("cond\n", "stdout");
  await output.write("x".repeat(60_001), "stderr");
  await output.flush();
  assert.deepEqual(lines.slice(0, 2), ["first", "second"]);
  assert.equal(lines.slice(2).join("").length, 60_001);
  assert.ok(lines.every((line) => line.length <= 30_000));
  const failing = lineOutput(async () => { throw new Error("persistence unavailable"); });
  await assert.rejects(failing.write("line\n", "stdout"), /persistence unavailable/);
});

test("archives are streamed to protected temporary files and removed after use", async () => {
  const archive = await boundedArchive(new Response(new Uint8Array([1, 2, 3, 4])), 4);
  assert.equal(archive.size, 4);
  assert.deepEqual(await readFile(archive.path), Buffer.from([1, 2, 3, 4]));
  await archive.dispose();
  await assert.rejects(access(archive.path));
  await assert.rejects(boundedArchive(new Response(new Uint8Array(5)), 4), /transfer limit/);
});

function mockGitHub(t: TestContext, tarballs: string[]) {
  t.mock.method(globalThis, "fetch", async (url: string | URL, options?: RequestInit) => {
    const path = String(url);
    if (path.includes("/git/ref/")) return Response.json({ object: { sha: "commit" } });
    if (path.includes("/git/commits/")) return Response.json({ sha: "commit", tree: { sha: "tree" } });
    if (path.includes("/git/trees/")) return Response.json({ tree: [], truncated: false });
    if (path.includes("/tarball/")) { tarballs.push(String(options?.headers)); return new Response("archive"); }
    throw new Error(`Unexpected request: ${path}`);
  });
}

test("immutable snapshots share archives only within the authorized credential scope", async (t) => {
  const tarballs: string[] = [];
  mockGitHub(t, tarballs);
  const [a, b, otherScope] = await Promise.all([
    getRepositorySnapshot("scope-one", "owner/repo", "main"),
    getRepositorySnapshot("scope-one", "owner/repo", "main"),
    getRepositorySnapshot("scope-two", "owner/repo", "main"),
  ]);
  assert.equal(a.archivePath, b.archivePath);
  assert.notEqual(a.archivePath, otherScope.archivePath);
  assert.equal(tarballs.length, 2);
  await a.dispose();
  await access(b.archivePath);
  await b.dispose();
  await assert.rejects(access(b.archivePath));
  await otherScope.dispose();
});

test("throttle classification distinguishes credentials and safe pre-agent failures", () => {
  const a = credentialScope("github", "scope-a");
  const b = credentialScope("github", "scope-b");
  const error = throttledResponse(new Response(null, { status: 429, headers: { "retry-after": "2" } }), a);
  assert.ok(error instanceof RetryablePreparationError);
  assert.equal(error.retryAfterMs, 2000);
  assert.ok(providerCooldown(a) > 0);
  assert.equal(providerCooldown(b), 0);
  assert.equal(throttledResponse(new Response(null, { status: 401 }), b), undefined);
  assert.equal(retryDelay(1, 0, () => 0), 10_000);
});

for (const template of ["", "custom-template", "base"]) {
  test(`E2B provisioning selects ${template || "claude by default"}`, async (t) => {
    const ctx = context();
    ctx.project.e2bTemplate = template;
    mockE2BSandbox(t, async (selectedTemplate: string) => {
      assert.equal(selectedTemplate, template || "claude");
      return { sandboxId: "template-test", commands: { run: async () => ({ exitCode: 0 }) } };
    });
    t.mock.method(Sandbox, "kill", async () => true);
    const sandbox = await createAgentSandbox(ctx, log);
    await sandbox.dispose();
  });
}

test("ownership is persisted before provisioning; provisioning failure disposes exactly once", async (t) => {
  const order: string[] = [];
  mockE2BSandbox(t, async () => {
    order.push("create");
    return { sandboxId: "owned", commands: { run: async () => { order.push("provision"); throw new Error("provision failed"); } } };
  });
  t.mock.method(Sandbox, "kill", async (id: string) => { assert.equal(id, "owned"); order.push("kill"); return true; });
  await assert.rejects(createAgentSandbox(context(), log, {
    onCreating: async () => { order.push("creating"); },
    onCreated: async () => { order.push("created"); },
    onDisposed: async () => { order.push("disposed"); },
  }), /provision failed/);
  assert.deepEqual(order, ["creating", "create", "created", "provision", "kill", "disposed"]);
});

test("failed disposal retains ownership for retry rather than confirming cleanup", async (t) => {
  let confirmed = false;
  const lines: string[] = [];
  mockE2BSandbox(t, async () => ({ sandboxId: "owned", commands: { run: async () => { throw new Error("provision failed"); } } }));
  t.mock.method(Sandbox, "kill", async () => { throw new Error("provider unavailable"); });
  await assert.rejects(createAgentSandbox(context(), async (line) => { lines.push(line); }, { onDisposed: async () => { confirmed = true; } }), /provision failed/);
  assert.equal(confirmed, false);
  assert.ok(lines.some((line) => line.includes("cleanup remains pending")));
});

test("known E2B control-plane refusals retry safely; ambiguous creation failures retain ownership", async (t) => {
  t.mock.method(Sandbox, "list", () => ({ hasNext: false }));
  const errors = [new E2BCreationRefusedError(429, "quota"), new E2BCreationRefusedError(503, "capacity"), new E2BCreationRefusedError(401, "bad credential"), new Error("network timeout")];
  for (const [index, error] of errors.entries()) {
    const ctx = context(); ctx.credentials.e2bApiKey = `unique-e2b-scope-${index}`;
    let confirmed = false;
    const mocked = t.mock.method(e2bControlPlane, "create", async () => { throw error; });
    const promise = createAgentSandbox(ctx, log, { onDisposed: async () => { confirmed = true; } });
    if (index < 2) await assert.rejects(promise, RetryablePreparationError);
    else await assert.rejects(promise, (actual: unknown) => actual === error);
    assert.equal(confirmed, index < 3);
    mocked.mock.restore();
  }
});

test("discovery validates immutable ownership and paginates provider records", async (t) => {
  let page = 0;
  let query: unknown;
  t.mock.method(Sandbox, "list", (options: unknown) => {
    query = options;
    return { get hasNext() { return page < 2; }, async nextItems() {
      page++;
      return [{ sandboxId: `owned-${page}`, metadata: { owner: sandboxOwnerId(), projectId: "p", runId: "r" }, endAt: new Date() },
        { sandboxId: "unrelated", metadata: { owner: "other", projectId: "p", runId: "r" }, endAt: new Date() }];
    } };
  });
  const resources = await discoverOwnedSandboxes("p", "r", "e2b", "secret");
  assert.deepEqual(resources.map((resource) => resource.id), ["owned-1", "owned-2"]);
  assert.deepEqual((query as { query: unknown }).query, { metadata: { app: "aira", owner: sandboxOwnerId(), projectId: "p", runId: "r" } });
});

test("runner always disposes on malformed agent response and propagates cancellation", async (t) => {
  const tarballs: string[] = [];
  mockGitHub(t, tarballs);
  let disposed = 0;
  t.mock.method(Sandbox, "kill", async () => { disposed++; return true; });
  mockE2BSandbox(t, async () => ({ sandboxId: "owned", commands: { run: async () => ({ exitCode: 0 }) }, files: {
    write: async (_name: string, data: unknown) => { if (data instanceof ReadableStream) { const reader = data.getReader(); while (!(await reader.read()).done) {} } },
    read: async () => new Response("{\"reply\":42}").body,
  } }));
  await assert.rejects(executeRun(context(), log), /valid reply/);
  assert.equal(disposed, 1);
  const controller = new AbortController(); controller.abort(new Error("shutdown"));
  await assert.rejects(executeRun(context(), log, { signal: controller.signal }), /shutdown/);
  assert.equal(disposed, 1);
});

test("successful output survives failed cleanup while disposal remains unconfirmed", async (t) => {
  mockGitHub(t, []);
  let confirmed = false;
  const lines: string[] = [];
  t.mock.method(Sandbox, "kill", async () => { throw new Error("cleanup temporarily unavailable"); });
  mockE2BSandbox(t, async () => ({ sandboxId: "owned", commands: { run: async () => ({ exitCode: 0 }) }, files: {
    write: async (_name: string, data: unknown) => { if (data instanceof ReadableStream) { const reader = data.getReader(); while (!(await reader.read()).done) {} } },
    read: async () => new Response(JSON.stringify({ reply: "Done", artifact: "# Definition" })).body,
  } }));
  const result = await executeRun(context(), async (line) => { lines.push(line); }, { onDisposed: async () => { confirmed = true; } });
  assert.deepEqual(result, { reply: "Done", artifact: "# Definition" });
  assert.equal(confirmed, false);
  assert.ok(lines.some((line) => line.includes("reservation is retained")));
});

test("cancelling an executing agent terminates its sandbox and cannot replay it", async (t) => {
  mockGitHub(t, []);
  const controller = new AbortController();
  let agentExecutions = 0;
  let kills = 0;
  t.mock.method(Sandbox, "kill", async () => { kills++; return true; });
  mockE2BSandbox(t, async () => ({ sandboxId: "owned", commands: {
    run: async (command: string, options: { signal: AbortSignal }) => {
      if (command.endsWith("runner.py run")) {
        agentExecutions++;
        setTimeout(() => controller.abort(new Error("agent cancelled")), 1);
        await new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
      }
      return { exitCode: 0 };
    },
  }, files: { write: async (_name: string, data: unknown) => { if (data instanceof ReadableStream) { const reader = data.getReader(); while (!(await reader.read()).done) {} } } } }));
  await assert.rejects(executeRun(context(), log, { signal: controller.signal }), /agent cancelled/);
  assert.equal(agentExecutions, 1);
  assert.equal(kills, 1);
});

test("cancelling one snapshot consumer keeps a shared authorized transfer alive", async (t) => {
  let body: ReadableStreamDefaultController<Uint8Array> | undefined;
  let startDownload!: () => void;
  const downloaded = new Promise<void>((resolve) => { startDownload = resolve; });
  t.mock.method(globalThis, "fetch", async (url: string | URL) => {
    const path = String(url);
    if (path.includes("/git/ref/")) return Response.json({ object: { sha: "commit-shared" } });
    if (path.includes("/git/commits/")) return Response.json({ sha: "commit-shared", tree: { sha: "tree" } });
    if (path.includes("/git/trees/")) return Response.json({ tree: [], truncated: false });
    if (path.includes("/tarball/")) return new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; startDownload(); } }));
    throw new Error(`Unexpected request: ${path}`);
  });
  const controller = new AbortController();
  const first = getRepositorySnapshot("shared-cancel-scope", "owner/repo", "main", controller.signal);
  const second = getRepositorySnapshot("shared-cancel-scope", "owner/repo", "main");
  await downloaded;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const cancelled = assert.rejects(first, /consumer cancelled/);
  controller.abort(new Error("consumer cancelled"));
  await cancelled;
  body!.enqueue(new TextEncoder().encode("archive")); body!.close();
  const retained = await second;
  assert.equal((await readFile(retained.archivePath)).toString(), "archive");
  await retained.dispose();
});

test("known credentials are redacted before forced line splits and independent stream chunk boundaries", async () => {
  const secret = "credential-secret-value-123456";
  const lines: string[] = [];
  const output = lineOutput(async (line) => { lines.push(line); }, 1024 * 1024, [secret, "short-key"]);
  await output.write("x".repeat(29_995) + secret.slice(0, 9), "stdout");
  await output.write("stderr: " + secret.slice(0, 17), "stderr");
  await output.write(secret.slice(9) + "\n", "stdout");
  await output.write(secret.slice(17) + " and short-", "stderr");
  await output.write("key\n", "stderr");
  await output.flush();
  const rendered = lines.join("");
  assert.equal(rendered.split("[REDACTED]").length - 1, 3);
  assert.ok(!rendered.includes(secret));
  assert.ok(!rendered.includes(secret.slice(0, 9)));
  assert.ok(!rendered.includes(secret.slice(9)));
  assert.ok(!rendered.includes("short-key"));
  assert.ok(lines.every((line) => line.length <= 30_000));
});

test("provider command handlers receive known secrets and redact fragmented output before buffering", async (t) => {
  const ctx = context();
  const lines: string[] = [];
  const secret = ctx.credentials.ollamaApiKey;
  t.mock.method(Sandbox, "kill", async () => true);
  mockE2BSandbox(t, async () => ({ sandboxId: "owned", commands: {
    run: async (_command: string, options: { onStdout?: (chunk: string) => Promise<void>; onStderr?: (chunk: string) => Promise<void> }) => {
      await options.onStdout?.("x".repeat(29_995) + secret.slice(0, 7));
      await options.onStderr?.("stderr: " + secret.slice(0, 7));
      await options.onStdout?.(secret.slice(7) + "\n");
      await options.onStderr?.(secret.slice(7) + "\n");
      return { exitCode: 0 };
    },
  } }));
  const sandbox = await createAgentSandbox(ctx, async (line) => { lines.push(line); });
  try { await sandbox.command("prepare", async (line) => { lines.push(line); }); }
  finally { await sandbox.dispose(); }
  const rendered = lines.join("");
  assert.equal(rendered.split("[REDACTED]").length - 1, 4);
  assert.ok(!rendered.includes(secret));
  assert.ok(!rendered.includes(secret.slice(0, 7)));
  assert.ok(!rendered.includes(secret.slice(7)));
});

test("snapshot deletion failures remain retryable and successful disposal stays idempotent", async (t) => {
  mockGitHub(t, []);
  const snapshot = await getRepositorySnapshot("cleanup-retry-scope", "owner/repo", "main");
  const directory = dirname(snapshot.archivePath);
  const originalRm = fsPromises.rm;
  let failed = false;
  const mocked = t.mock.method(fsPromises, "rm", async (path: Parameters<typeof originalRm>[0], options?: Parameters<typeof originalRm>[1]) => {
    if (path === directory && !failed) { failed = true; throw new Error("transient archive deletion failure"); }
    return originalRm(path, options);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(snapshot.dispose(), /transient archive deletion failure/);
    await access(snapshot.archivePath);
    await snapshot.dispose();
    await assert.rejects(access(snapshot.archivePath));
    await snapshot.dispose();
  } finally {
    mocked.mock.restore(); syncBuiltinESMExports();
    await snapshot.dispose(); await originalRm(directory, { recursive: true, force: true });
  }
});

test("failed deletions retain bounded archive storage capacity until cleanup succeeds", async (t) => {
  const archives = await Promise.all(Array.from({ length: 4 }, () => boundedArchive(new Response("archive"), 100)));
  const directories = new Set(archives.map((archive) => dirname(archive.path)));
  const originalRm = fsPromises.rm;
  const mocked = t.mock.method(fsPromises, "rm", async (path: Parameters<typeof originalRm>[0], options?: Parameters<typeof originalRm>[1]) => {
    if (typeof path === "string" && directories.has(path)) throw new Error("archive storage unavailable");
    return originalRm(path, options);
  });
  syncBuiltinESMExports();
  try {
    for (const archive of archives) await assert.rejects(archive.dispose(), /archive storage unavailable/);
    const controller = new AbortController();
    let admitted = false;
    const blocked = boundedArchive(new Response("fifth archive"), 100, controller.signal).then((archive) => { admitted = true; return archive; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(admitted, false);
    const cancelled = assert.rejects(blocked, /storage cancelled/);
    controller.abort(new Error("storage cancelled"));
    await cancelled;
  } finally {
    mocked.mock.restore(); syncBuiltinESMExports();
    for (const archive of archives) await archive.dispose();
  }
  const next = await boundedArchive(new Response("available"), 100);
  await next.dispose();
});

test("a typed SDK connection error after accepted creation cannot release ownership or replay creation", async (t) => {
  const ctx = context(); ctx.credentials.e2bApiKey = "accepted-create-then-cleanup-refusal";
  let confirmed = false;
  let owned = false;
  let creations = 0;
  let creatingExpiry = "";
  const cleanupError = new RateLimitError("SDK connection failed after successful creation");
  t.mock.method(e2bControlPlane, "create", async () => { creations++; return "owned"; });
  t.mock.method(Sandbox, "connect", async (_id: string, options: any) => {
    assert.equal(owned, true);
    assert.equal(options.timeoutMs, undefined, "connection cannot extend the durable provider lifetime");
    throw cleanupError;
  });
  t.mock.method(Sandbox, "kill", async () => { throw new RateLimitError("cleanup refused"); });
  await assert.rejects(createAgentSandbox(ctx, log, {
    onCreating: async (_provider, expiresAt) => { creatingExpiry = expiresAt; },
    onCreated: async (resource) => {
      assert.ok(Date.parse(creatingExpiry) - Date.parse(resource.expiresAt) > 59_000,
        "ambiguous creation reservation includes the request deadline");
      owned = true;
    },
    onDisposed: async () => { confirmed = true; },
  }), (error: unknown) => error === cleanupError);
  assert.equal(owned, true);
  assert.equal(confirmed, false);
  assert.equal(creations, 1);
});

test("an ambiguous SDK creation failure is released only after owned resources terminate", async (t) => {
  const ctx = context(); ctx.credentials.e2bApiKey = "ambiguous-found-and-terminated";
  let confirmed = false;
  let terminated = false;
  t.mock.method(e2bControlPlane, "create", async () => { throw new Error("lost creation response"); });
  t.mock.method(Sandbox, "list", () => ({ hasNext: true, async nextItems() {
    this.hasNext = false;
    return [{ sandboxId: "owned", metadata: { owner: sandboxOwnerId(), projectId: ctx.project.id, runId: ctx.run.id }, endAt: new Date() }];
  } }));
  t.mock.method(Sandbox, "kill", async (id: string) => { assert.equal(id, "owned"); terminated = true; return true; });
  await assert.rejects(createAgentSandbox(ctx, log, { onDisposed: async () => { assert.equal(terminated, true); confirmed = true; } }), /lost creation response/);
  assert.equal(confirmed, true);
});
