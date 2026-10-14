import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectsApp } from "./App";
import type { Project, SessionData } from "../shared/types";

const project: Project = {
  id: "project", name: "Team", key: "TEAM", description: "", repository: "",
  baseBranch: "main", model: "model", modelProvider: "ollama", sandboxProvider: "docker",
  maxConcurrentRuns: 100, dockerImage: "image", e2bTemplate: "", steps: [],
  roles: { member: "member" }, githubConnected: false, githubIdentity: "",
  hasOllamaKey: false, hasClaudeKey: false, hasE2bKey: false,
};
function render(canCreateProjects: boolean, projects: Project[], isSystemUser = false) {
  const session: SessionData = {
    user: { id: "member", name: "Member", email: "member@example.test", mustChangePassword: false, isSystemUser },
    canCreateProjects, projects,
  };
  return renderToStaticMarkup(<ProjectsApp session={session} setSession={() => {}} logout={() => {}} />);
}

test("members cannot see the sidebar project creation control", () => {
  assert.doesNotMatch(render(false, [project]), /Create new project|Create a project/);
});
test("project creation is available only to the system user inside the project switcher", () => {
  assert.doesNotMatch(render(true, [project]), /Create new project/);
  assert.doesNotMatch(render(true, [{ ...project, roles: { member: "admin" } }]), /Create new project/);
  const html = render(true, [project], true);
  assert.match(html, /<select aria-label="Project">.*<option value="__create">Create new project<\/option>.*<\/select>/);
  assert.doesNotMatch(html, /aria-label="New project"/);
});
test("accounts without project access see an access prompt without a creation form", () => {
  const html = render(false, []);
  assert.match(html, /Ask a project administrator to add you to a project/);
  assert.doesNotMatch(html, /Create project|Project name|Ticket prefix|<form/);
  assert.match(html, /Sign out/);
});
test("initial setup account can create its first project", () => {
  const html = render(true, [], true);
  assert.match(html, /Create project/);
  assert.match(html, /Project name/);
  assert.match(html, /Ticket prefix/);
});


test("Analytics navigation is limited to admins and explicitly granted project members", () => {
  assert.doesNotMatch(render(false, [project]), /aria-label="Analytics"/);
  assert.match(render(false, [{ ...project, analyticsMemberIds: ["member"] }]), /aria-label="Analytics"/);
  assert.match(render(true, [{ ...project, roles: { member: "admin" } }]), /aria-label="Analytics"/);
});

test("optional permissions control Analytics and Config navigation", () => {
  assert.doesNotMatch(render(false, [project]), /aria-label="Config"/);
  assert.match(render(false, [{ ...project, memberPermissions: { member: ["peopleRead"] } }]), /aria-label="Config"/);
  assert.match(render(false, [{ ...project, memberPermissions: { member: ["workflowWrite"] } }]), /aria-label="Config"/);
  assert.match(render(false, [{ ...project, memberPermissions: { member: ["generalWrite"] } }]), /aria-label="Config"/);
  const html = render(false, [{ ...project, memberPermissions: { member: ["analytics"] } }]);
  assert.match(html, /aria-label="Analytics"/);
  assert.doesNotMatch(html, /aria-label="Config"/);
});


test("General and Sandbox readonly permissions expose Config navigation", () => {
  assert.match(render(false, [{ ...project, memberPermissions: { member: ["generalRead"] } }]), /aria-label="Config"/);
  assert.match(render(false, [{ ...project, memberPermissions: { member: ["sandboxRead"] } }]), /aria-label="Config"/);
  assert.match(render(false, [{ ...project, memberPermissions: { member: ["sandboxWrite"] } }]), /aria-label="Config"/);
});
