import type { Project } from "../shared/types";

export function projectSettings(project: Project) {
  return {
    name: project.name,
    description: project.description,
    repository: project.repository,
    baseBranch: project.baseBranch,
    model: project.model,
    modelProvider: project.modelProvider,
    sandboxProvider: project.sandboxProvider,
    dockerImage: project.dockerImage,
    e2bTemplate: project.e2bTemplate,
    maxConcurrentRuns: String(project.maxConcurrentRuns),
  };
}

export function settleSettingsSave(
  current: ReturnType<typeof projectSettings>,
  submitted: ReturnType<typeof projectSettings>,
  saved: ReturnType<typeof projectSettings>,
) {
  return JSON.stringify(current) === JSON.stringify(submitted) ? saved : current;
}

export function concurrentSandboxLimit(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 2_147_483_647
    ? parsed
    : null;
}
