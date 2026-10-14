import assert from "node:assert/strict";
import test from "node:test";
import { hasProjectPermission, projectPermissions, PROJECT_PERMISSIONS } from "../src/shared/permissions.js";
import type { Project } from "../src/shared/types.js";

const project: Pick<Project, "roles" | "memberPermissions" | "analyticsMemberIds"> = {
  roles: { admin: "admin", basic: "member", analyst: "member", reader: "member", writer: "member" },
  memberPermissions: { basic: [], analyst: ["analytics"], reader: ["peopleRead"], writer: ["analytics", "peopleWrite"] },
};

test("feature grants implement basic, analytics, readonly people, and delegated people access", () => {
  assert.deepEqual(projectPermissions(project, "basic"), []);
  assert.deepEqual(projectPermissions(project, "analyst"), ["analytics"]);
  assert.deepEqual(projectPermissions(project, "reader"), ["peopleRead"]);
  assert.deepEqual(projectPermissions(project, "writer"), ["analytics", "peopleRead", "peopleWrite"]);
  assert.equal(hasProjectPermission(project, "reader", "peopleWrite"), false);
  assert.equal(hasProjectPermission(project, "writer", "generalWrite"), false);
  assert.deepEqual(projectPermissions(project, "admin"), PROJECT_PERMISSIONS);
});

test("membership is required and explicit grants supersede legacy analytics access", () => {
  assert.deepEqual(projectPermissions({ ...project, memberPermissions: { outsider: ["generalWrite"] } }, "outsider"), []);
  assert.deepEqual(projectPermissions({ ...project, memberPermissions: undefined, analyticsMemberIds: ["basic"] }, "basic"), ["analytics"]);
  assert.deepEqual(projectPermissions({ ...project, analyticsMemberIds: ["basic"] }, "basic"), []);
});

test("write grants include read access independently for each configuration area", () => {
  assert.deepEqual(projectPermissions({ ...project, memberPermissions: { basic: ["generalWrite"] } }, "basic"), ["generalRead", "generalWrite"]);
  assert.deepEqual(projectPermissions({ ...project, memberPermissions: { basic: ["sandboxWrite"] } }, "basic"), ["sandboxRead", "sandboxWrite"]);
  assert.deepEqual(projectPermissions({ ...project, memberPermissions: { basic: ["generalRead", "sandboxRead", "peopleRead"] } }, "basic"), ["peopleRead", "generalRead", "sandboxRead"]);
  assert.equal(hasProjectPermission({ ...project, memberPermissions: { basic: ["sandboxWrite"] } }, "basic", "generalWrite"), false);
});
