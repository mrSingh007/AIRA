import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Sandbox } from "@e2b/code-interpreter";
import type { RunContext } from "../src/shared/types.js";
import { executeRun } from "../src/server/runner.js";
import { e2bControlPlane } from "../src/server/sandbox.js";
import { preparationGate, RetryablePreparationError } from "../src/server/preparation.js";

function context(kind: RunContext["run"]["kind"] = "definition"): RunContext {
  return {
    run: { id: "contract-run", kind },
    project: { id: "contract-project", sandboxProvider: "e2b", modelProvider: "ollama", e2bTemplate: "base", repository: "owner/repo", baseBranch: "main", model: "project-model:cloud", steps: [{ id: "step" }] },
    step: { id: "step", name: "Definition", instructions: "Write a definition", model: "" },
    ticket: { number: "KANGENTIX-1", title: "Task", description: "Context" },
    artifacts: [], attachments: [], messages: [],
    credentials: { githubToken: "contract-github-secret", claudeApiKey: "contract-claude-secret", ollamaApiKey: "contract-ollama-secret", e2bApiKey: "contract-e2b-secret" },
  } as unknown as RunContext;
}

function provider(t: TestContext, response: unknown, changes: unknown = [], runError?: Error) {
  const commands: string[] = [];
  const requests: RequestInit[] = [];
  let kills = 0;
  let input: { model: string; prompt: string; modelProvider: string; apiKey: string; documents: Array<{ path: string }> } | undefined;
  const fetch = t.mock.method(globalThis, "fetch", async (url: string | URL, options: RequestInit = {}) => {
    requests.push(options);
    const path = String(url);
    if (path.includes("/git/ref/")) return Response.json({ object: { sha: "contract-commit" } });
    if (path.includes("/git/commits/")) return Response.json({ sha: "contract-commit", tree: { sha: "contract-tree" } });
    if (path.includes("/git/trees/")) return Response.json({ tree: [], truncated: false });
    if (path.includes("/tarball/")) return new Response("archive");
    throw new Error(`Unexpected external request: ${path}`);
  });
  const create = t.mock.method(e2bControlPlane, "create", async () => "contract-sandbox");
  t.mock.method(Sandbox, "kill", async () => { kills++; return true; });
  t.mock.method(Sandbox, "connect", async () => ({
    commands: { run: async (command: string) => {
      commands.push(command);
      if (command.endsWith("runner.py run") && runError) throw runError;
      return { exitCode: 0 };
    } },
    files: {
      write: async (name: string, data: unknown) => {
        if (name.endsWith("/input.json")) input = JSON.parse(data as string);
        if (data instanceof ReadableStream) {
          const reader = data.getReader();
          while (!(await reader.read()).done) { /* Consume streamed archive upload. */ }
        }
      },
      read: async (name: string) => new Response(JSON.stringify(name.endsWith("/changes.json") ? changes : response)).body,
    },
  }));
  return { commands, requests, fetch, create, get kills() { return kills; }, get input() { return input; } };
}

test("runner rejects invalid project input before requesting external resources", async (t) => {
  const external = provider(t, { reply: "Done", artifact: "Definition" });
  const cases: Array<{ change: (ctx: RunContext) => void; error: RegExp }> = [
    { change: ctx => { ctx.credentials.githubToken = ""; }, error: /Connect a GitHub repository/ },
    { change: ctx => { ctx.project.repository = ""; }, error: /Connect a GitHub repository/ },
    { change: ctx => { ctx.credentials.ollamaApiKey = ""; }, error: /Ollama Cloud API key/ },
    { change: ctx => { ctx.project.modelProvider = "invalid" as RunContext["project"]["modelProvider"]; }, error: /valid model provider/ },
    { change: ctx => { ctx.project.modelProvider = "claude"; ctx.credentials.claudeApiKey = ""; }, error: /Claude API key/ },
    { change: ctx => { ctx.project.modelProvider = "claude"; ctx.project.model = " "; }, error: /valid Claude model/ },
    { change: ctx => { ctx.project.model = " :cloud"; }, error: /valid Ollama Cloud model/ },
    { change: ctx => { ctx.step.model = "bad\nmodel"; }, error: /valid Ollama Cloud model/ },
    { change: ctx => { ctx.project.model = "x".repeat(151); }, error: /valid Ollama Cloud model/ },
    { change: ctx => { ctx.ticket.description = "x".repeat(2 * 1024 * 1024); }, error: /2 MiB agent input limit/ },
  ];
  for (const fixture of cases) {
    const ctx = context(); fixture.change(ctx);
    await assert.rejects(executeRun(ctx, async () => {}), fixture.error);
  }
  assert.equal(external.fetch.mock.callCount(), 0);
  assert.equal(external.create.mock.callCount(), 0);
  assert.equal(preparationGate.occupancy, 0);
});

test("step model overrides the project model and credentials are redacted in returned documents", async (t) => {
  const ctx = context();
  ctx.step.model = " step-model:cloud ";
  const external = provider(t, { reply: `Done ${ctx.credentials.githubToken}`, artifact: `Document ${ctx.credentials.ollamaApiKey}` });
  const result = await executeRun(ctx, async () => {});
  assert.equal(external.input?.model, "step-model");
  assert.equal(external.input?.modelProvider, "ollama");
  assert.equal(external.input?.apiKey, ctx.credentials.ollamaApiKey);
  assert.deepEqual(result, { reply: "Done [REDACTED]", artifact: "Document [REDACTED]" });
  assert.equal(external.kills, 1);
  assert.equal(preparationGate.occupancy, 0);
});

test("Claude runs use the selected key and model unchanged and redact both provider keys", async (t) => {
  const ctx = context();
  ctx.project.modelProvider = "claude";
  ctx.credentials.ollamaApiKey = "";
  ctx.step.model = " claude-model:cloud ";
  const external = provider(t, { reply: `Done ${ctx.credentials.claudeApiKey}`, artifact: "Definition" });
  const logs: string[] = [];
  assert.deepEqual(await executeRun(ctx, async line => { logs.push(line); }), { reply: "Done [REDACTED]", artifact: "Definition" });
  assert.equal(external.input?.modelProvider, "claude");
  assert.equal(external.input?.apiKey, ctx.credentials.claudeApiKey);
  assert.equal(external.input?.model, "claude-model:cloud");
  assert.ok(logs.some(line => line.includes("on Claude.")));
  assert.equal(external.kills, 1);
});

for (const [name, response, error] of [
  ["missing definition artifact", { reply: "Done" }, /required Markdown artifact/],
  ["blank artifact", { reply: "Done", artifact: " \n" }, /non-empty Markdown/],
  ["non-string artifact", { reply: "Done", artifact: 42 }, /non-empty Markdown/],
  ["oversized UTF-8 artifact", { reply: "Done", artifact: "é".repeat(250_001) }, /below 500 KB/],
  ["blank reply", { reply: " \n", artifact: "Definition" }, /valid reply/],
] as const) {
  test(`runner rejects ${name} and releases its sandbox`, async (t) => {
    const external = provider(t, response);
    await assert.rejects(executeRun(context(), async () => {}), error);
    assert.equal(external.kills, 1);
    assert.equal(preparationGate.occupancy, 0);
  });
}

test("chat accepts a reply without a document revision", async (t) => {
  provider(t, { reply: "Explanation" });
  assert.deepEqual(await executeRun(context("chat"), async () => {}), { reply: "Explanation" });
});

test("chat avoids revisions for unchanged documents", async (t) => {
  const ctx = context("chat");
  ctx.artifacts = [{ stepId: ctx.step.id, filename: "definition.md", content: "Original definition" }] as RunContext["artifacts"];
  const external = provider(t, { reply: "Explanation", artifact: "Original definition" });
  assert.deepEqual(await executeRun(ctx, async () => {}), { reply: "Explanation" });
  assert.equal(external.kills, 1);
});

test("chat returns revised document contents", async (t) => {
  const ctx = context("chat");
  ctx.artifacts = [{ stepId: ctx.step.id, filename: "definition.md", content: "Original definition" }] as RunContext["artifacts"];
  provider(t, { reply: "Updated", artifact: "Revised definition" });
  assert.deepEqual(await executeRun(ctx, async () => {}), { reply: "Updated", artifact: "Revised definition" });
});

test("implementation with no repository changes skips publishing", async (t) => {
  const external = provider(t, { reply: "Already implemented" });
  assert.deepEqual(await executeRun(context("implement"), async () => {}), { reply: "Already implemented", noChanges: true });
  assert.ok(external.commands.some(command => command.endsWith("runner.py export")));
  assert.equal(external.kills, 1);
});

test("changed files containing credentials stop publication before GitHub writes", async (t) => {
  const ctx = context("implement");
  const external = provider(t, { reply: "Implemented" }, [{ path: "source.txt", mode: "100644", content: Buffer.from(ctx.credentials.githubToken).toString("base64") }]);
  await assert.rejects(executeRun(ctx, async () => {}), /changed file contains a configured credential/);
  assert.equal(external.kills, 1);
  assert.ok(external.requests.every(request => !request.body && (!request.method || request.method === "GET")));
});

test("throttling after agent execution becomes terminal instead of replaying execution", async (t) => {
  const pressure = new RetryablePreparationError("Agent execution throttled", "contract-execution-scope");
  const external = provider(t, null, [], pressure);
  await assert.rejects(executeRun(context(), async () => {}), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!(error instanceof RetryablePreparationError));
    assert.equal(error.cause, pressure);
    return true;
  });
  assert.equal(external.commands.filter(command => command.endsWith("runner.py run")).length, 1);
  assert.equal(external.kills, 1);
});

test("implementation supplies Kangentix instructions and document paths to the sandbox", async (t) => {
  const ctx = context("implement");
  ctx.artifacts = [{ stepId: ctx.step.id, filename: "definition.md", content: "Approved definition" }] as RunContext["artifacts"];
  const external = provider(t, { reply: "Already implemented" });
  assert.deepEqual(await executeRun(ctx, async () => {}), { reply: "Already implemented", noChanges: true });
  assert.ok(external.input?.prompt.includes("a Kangentix software delivery ticket"));
  assert.ok(external.input?.prompt.includes("trusted Kangentix service"));
  assert.deepEqual(external.input?.documents.map(document => document.path), ["docs/kangentix/KANGENTIX-1/definition.md"]);
  assert.ok(external.commands.some(command => command.includes("python3 /tmp/kangentix/runner.py run")));
});

test("Markdown ticket attachments are supplied to document agents with readable file references", async (t) => {
  const ctx = context();
  const content = Buffer.from("# Uploaded context\nRequired behavior.");
  const attachment = { id: "00000000-0000-4000-8000-000000000001", filename: "requirements.md", contentType: "text/markdown" as const, size: content.length, data: content.toString("base64") };
  ctx.attachments = [attachment];
  const external = provider(t, { reply: "Done", artifact: "# Definition" });
  await executeRun(ctx, async () => {});
  const input = external.input as unknown as { prompt: string; attachments: Array<{ path: string; content: string }> };
  assert.match(input.prompt, /requirements\.md/);
  assert.deepEqual(input.attachments, [{ path: `docs/kangentix/KANGENTIX-1/attachments/${attachment.id}.md`, content: attachment.data }]);
});
