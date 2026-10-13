import type { Run, Step, Ticket } from "./types.js";

export function requiredApprovalCount(step: Step): number {
  return step.requiredApprovals;
}

export function implementationReady(
  ticket: Ticket,
  step: Step,
  runs: Run[],
): boolean {
  const latest = runs
    .filter(
      (run) =>
        run.ticketId === ticket.id &&
        run.stepId === step.id &&
        run.kind === "implement",
    )
    .at(-1);
  return (
    step.kind === "implement" &&
    latest?.status === "completed" &&
    (latest.noChanges === true ||
      ticket.pullRequests.some(
        (pr) =>
          pr.stepId === step.id &&
          pr.runId === latest.id &&
          pr.number > 0 &&
          !!pr.url,
      ))
  );
}
