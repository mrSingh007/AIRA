import type { Project, ProjectPermission } from "./types.js";

export const PROJECT_PERMISSIONS: readonly ProjectPermission[] = [
  "analytics", "peopleRead", "peopleWrite", "workflowWrite", "generalRead", "generalWrite", "sandboxRead", "sandboxWrite",
];

/** Membership always includes Board, Backlog, and Done access. */
export function projectPermissions(
  project: Pick<Project, "roles" | "memberPermissions" | "analyticsMemberIds">,
  userId: string,
): ProjectPermission[] {
  if (!project.roles[userId]) return [];
  if (project.roles[userId] === "admin") return [...PROJECT_PERMISSIONS];
  const saved = project.memberPermissions?.[userId];
  const permissions = new Set<ProjectPermission>(saved ??
    (project.analyticsMemberIds?.includes(userId) ? ["analytics"] : []));
  if (permissions.has("peopleWrite")) permissions.add("peopleRead");
  if (permissions.has("generalWrite")) permissions.add("generalRead");
  if (permissions.has("sandboxWrite")) permissions.add("sandboxRead");
  return PROJECT_PERMISSIONS.filter(permission => permissions.has(permission));
}

export function hasProjectPermission(
  project: Pick<Project, "roles" | "memberPermissions" | "analyticsMemberIds">,
  userId: string,
  permission: ProjectPermission,
): boolean {
  return projectPermissions(project, userId).includes(permission);
}
