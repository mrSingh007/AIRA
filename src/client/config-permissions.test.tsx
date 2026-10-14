import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Config } from "./Config";
import type { ProjectData, ProjectPermission } from "../shared/types";

function render(permissions: ProjectPermission[], workflowLocked = false) {
  const data: ProjectData = {
    project: {
      id: "project", name: "Team", key: "TEAM", description: "", repository: "",
      baseBranch: "main", model: "model", modelProvider: "ollama", sandboxProvider: "docker",
      maxConcurrentRuns: 100, dockerImage: "image", e2bTemplate: "",
      steps: [{ id: "step", name: "Review", kind: "manual", instructions: "", model: "", requiredApprovals: 1, approverIds: [], hiddenApproverCount: 1, includePriorArtifacts: false, filename: "review.md" }],
      roles: { member: "member", other: "member", system: "admin" }, memberPermissions: { member: permissions },
      githubConnected: false, githubIdentity: "", hasOllamaKey: false, hasClaudeKey: false, hasE2bKey: false,
    },
    members: [
      { id: "member", name: "Member", email: "member@example.test", mustChangePassword: false, role: "member" },
      { id: "other", name: "Other", email: "other@example.test", mustChangePassword: false, role: "member" },
      { id: "system", name: "System", email: "system@example.test", mustChangePassword: false, role: "admin", isSystemUser: true },
    ],
    sprints: [], tickets: [], artifacts: [], approvals: [], threads: [], messages: [], runs: [], audit: [], workflowLocked,
  };
  return renderToStaticMarkup(<Config data={data} userId="member" refresh={async () => {}} notify={() => {}} setError={() => {}} />);
}

test("readonly Users shows both panels with disabled creation form and no system identity", () => {
  const html = render(["peopleRead"]);
  assert.match(html, /Your project team/);
  assert.match(html, /Bring someone in|Find existing user/);
  assert.match(html, /<fieldset class="config-fields config-panel-fieldset" disabled=""/);
  assert.doesNotMatch(html, /System user|system@example.test|Basic access for System/);
  assert.match(html, /disabled="" aria-label="Basic access for Member" checked=""/);
  assert.match(html, /aria-label="Remove Other from project" disabled=""/);
});

test("Users writers can grant only their own optional permissions", () => {
  const html = render(["peopleWrite", "analytics"]);
  assert.match(html, /Bring someone in/);
  assert.match(html, /aria-label="Analytics access for new member"/);
  assert.match(html, /disabled="" aria-label="Workflow — Write access for new member"/);
  assert.match(html, /disabled="" aria-label="General — Read access for new member"/);
  assert.match(html, /disabled="" aria-label="General — Write access for new member"/);
  assert.match(html, /disabled="" aria-label="Sandbox &amp; models — Read access for new member"/);
  assert.doesNotMatch(html, /Project role|System user|system@example.test/);
});

test("workflow writers edit approval counts with hidden reviewers while structure is locked", () => {
  const html = render(["workflowWrite"], true);
  assert.match(html, /Save workflow/);
  assert.doesNotMatch(html, /Your project team|Models &amp; credentials|system@example.test|title="System"/);
  assert.match(html, /type="number" min="1" max="1" value="1"/);
  assert.match(html, /Workflow structure stays locked/);
});

test("General write sees only essentials and repository settings", () => {
  const html = render(["generalWrite"]);
  assert.match(html, /The essentials|GitHub repository/);
  assert.match(html, /Save general settings/);
  assert.doesNotMatch(html, /Your project team|Save workflow|Models &amp; credentials|Agent sandbox/);
});

test("General read sees all general fields disabled and no save or connect action", () => {
  const html = render(["generalRead"]);
  assert.match(html, /The essentials|GitHub repository|Ticket prefixes are permanent/);
  assert.match(html, /<fieldset class="config-panel-fieldset" disabled=""/);
  assert.doesNotMatch(html, /Save general settings|Connect GitHub|Verify connection/);
});

test("Sandbox read sees models and sandbox fields disabled and no save action", () => {
  const html = render(["sandboxRead"]);
  assert.match(html, /Models &amp; credentials|Agent sandbox|Concurrent sandboxes/);
  assert.match(html, /<fieldset class="config-panel-fieldset" disabled=""/);
  assert.doesNotMatch(html, /The essentials|GitHub repository|Save sandbox &amp; models/);
});

test("Sandbox write allows model settings without general settings", () => {
  const html = render(["sandboxWrite"]);
  assert.match(html, /Models &amp; credentials|Agent sandbox|Save sandbox &amp; models/);
  assert.doesNotMatch(html, /<fieldset class="config-panel-fieldset" disabled=""|The essentials|GitHub repository/);
});

test("full feature access offers the four named Config tabs", () => {
  const html = render(["generalWrite", "sandboxWrite", "workflowWrite", "peopleWrite"]);
  assert.match(html, />General<\/button>/);
  assert.match(html, />Sandbox &amp; models<\/button>/);
  assert.match(html, />Workflow<\/button>/);
  assert.match(html, />Users<span/);
});
