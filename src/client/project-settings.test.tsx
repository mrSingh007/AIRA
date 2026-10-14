import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelProvider, ProjectData, SandboxProvider } from "../shared/types";
import { Config } from "./Config";
import { concurrentSandboxLimit, settleSettingsSave } from "./project-settings";

const savedSettings = {
  key: "TEAM", name: "Project", description: "", repository: "owner/repo", baseBranch: "main",
  model: "model", modelProvider: "ollama" as const, sandboxProvider: "docker" as const, dockerImage: "image", e2bTemplate: "",
  maxConcurrentRuns: "100",
};

test("saving alternate valid number notation restores the canonical, clean settings draft", () => {
  for (const raw of ["0100", "100.0", "1e2"]) {
    const submitted = { ...savedSettings, maxConcurrentRuns: raw };
    assert.equal(concurrentSandboxLimit(raw), 100);
    assert.deepEqual(settleSettingsSave(submitted, submitted, savedSettings), savedSettings);
  }
});

test("save acknowledgement preserves settings edited while the request was in flight", () => {
  const submitted = { ...savedSettings, maxConcurrentRuns: "0100" };
  const current = { ...submitted, name: "Changed while saving", maxConcurrentRuns: "250" };
  assert.equal(settleSettingsSave(current, submitted, savedSettings), current);
  assert.equal(current.maxConcurrentRuns, "250");
});

test("concurrency form validates empty, fractional, nonfinite, and storage-bound values", () => {
  for (const value of ["", " ", "0", "-1", "0.5", "100.1", "NaN", "Infinity", "abc", "2147483648"]) {
    assert.equal(concurrentSandboxLimit(value), null, value);
  }
  for (const value of ["1", "100", "101", "2147483647"]) {
    assert.equal(concurrentSandboxLimit(value), Number(value), value);
  }
});

function configData(sandboxProvider: SandboxProvider = "docker", modelProvider: ModelProvider = "ollama"): ProjectData {
  return {
      project: {
        id: "project", name: "Project", key: "PROJ", description: "", repository: "", baseBranch: "main",
        model: "model", modelProvider, sandboxProvider, dockerImage: "image", e2bTemplate: "template",
        maxConcurrentRuns: 101, steps: [], roles: { member: "member" }, memberPermissions: { member: ["sandboxWrite"] }, githubConnected: false,
        githubIdentity: "", hasOllamaKey: false, hasClaudeKey: false, hasE2bKey: false,
      },
      members: [], tickets: [], artifacts: [], approvals: [], threads: [], messages: [],
      runs: [], audit: [], workflowLocked: false,
    };
}

function renderConfig(data: ProjectData) {
  return renderToStaticMarkup(<Config data={data} userId="member" refresh={async () => {}} notify={() => {}} setError={() => {}} />);
}

for (const sandboxProvider of ["docker", "e2b"] as const) {
  test(`concurrency input is rendered under Agent sandbox for ${sandboxProvider}`, () => {
    const data = configData(sandboxProvider);
    const markup = renderConfig(data);
    const inputStart = markup.indexOf("Concurrent sandboxes");
    assert.ok(inputStart > markup.indexOf("Agent sandbox"));
    const input = markup.slice(inputStart).match(/<input[^>]+>/)?.[0];
    assert.ok(input);
    assert.match(input, /type="number"/);
    assert.match(input, /min="1"/);
    assert.match(input, /max="2147483647"/);
    assert.match(input, /value="101"/);
    assert.match(markup, /Maximum simultaneous agent runs for this project\. Default: 100\./);
  });
}

for (const modelProvider of ["ollama", "claude"] as const) {
  test(`model configuration selects ${modelProvider} and shows its key and account link`, () => {
    const data = configData("docker", modelProvider);
    const markup = renderConfig(data);
    assert.match(markup, new RegExp(`<option value="${modelProvider}" selected=""`));
    const provider = modelProvider === "claude" ? "Claude" : "Ollama Cloud";
    const other = modelProvider === "claude" ? "Ollama Cloud" : "Claude";
    assert.ok(markup.includes(`${provider} API key`));
    assert.ok(!markup.includes(`${other} API key`));
    assert.ok(markup.includes(modelProvider === "claude" ? "https://platform.claude.com/settings/keys" : "https://ollama.com/settings/keys"));
    assert.ok(!markup.includes("Saved securely"));
    if (modelProvider === "claude") data.project.hasClaudeKey = true;
    else data.project.hasOllamaKey = true;
    assert.ok(renderConfig(data).includes("Saved securely"));
  });

  test(`${modelProvider} key status does not use the other provider's stored key`, () => {
    const data = configData("docker", modelProvider);
    if (modelProvider === "claude") data.project.hasOllamaKey = true;
    else data.project.hasClaudeKey = true;
    assert.ok(!renderConfig(data).includes("Saved securely"));
  });
}

test("save acknowledgement preserves provider changes made while a request is in flight", () => {
  const current = { ...savedSettings, modelProvider: "claude" as const, model: "sonnet" };
  assert.equal(settleSettingsSave(current, savedSettings, savedSettings), current);
});

test("save acknowledgement preserves an edited ticket prefix", () => {
  const submitted = { ...savedSettings, key: "NEW" };
  const current = { ...submitted, key: "LATEST" };
  assert.equal(settleSettingsSave(current, submitted, submitted).key, "LATEST");
  assert.equal(settleSettingsSave(submitted, submitted, submitted).key, "NEW");
});
