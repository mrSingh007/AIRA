# Working on Kangentix

Kangentix is a self-hosted agentic Kanban board for bounded agent execution with people in the loop. Teams collaborate through configurable manual/agent steps, Markdown documents, discussions, human reviews and approvals, and GitHub PR publication. React and Express share TypeScript contracts; PostgreSQL persists state. Claude Code executes in disposable Docker or E2B sandboxes using Ollama Cloud or Claude as the model provider.

Read [README.md](README.md) for setup and [docs/FEATURES.md](docs/FEATURES.md) for product behavior. This file covers implementation guidance; inspect the relevant code before changing it.

## Working agreements

- Use sub-agents when possible for independent implementation, investigation, or review. Assign clear file ownership, coordinate shared contracts, and review their changes before integrating them. Avoid concurrent edits to the same files or concurrent integration suites against one database.
- Preserve existing user changes in the working tree. Keep edits scoped to the requested feature or fix; follow nearby code conventions rather than reformatting unrelated files.
- Preserve application data, accounts, project settings, and credentials unless the requested task explicitly requires changing or resetting them. Do not reset application data merely to make tests pass.
- Keep author attribution to **Harvinder Mand** in `LICENSE`, README, and package metadata. Do not add per-file author/license headers.

## Code map

| Area | Start here |
| --- | --- |
| Public data contracts, project permissions, and shared workflow rules | `src/shared/types.ts`, `src/shared/permissions.ts`, `src/shared/workflow.ts` |
| Board, backlog, account UI | `src/client/App.tsx`, `src/client/board-tickets.ts` |
| Project analytics | `src/server/analytics.ts`, `src/client/Analytics.tsx` |
| Project settings, providers, workflows, people | `src/client/Config.tsx`, `src/client/project-settings.ts` |
| Ticket documents, discussions, approvals, execution history | `src/client/TicketDetail.tsx`, `src/client/TicketImages.tsx`, `src/client/ticket-history.ts`, `src/client/run-logs.ts` |
| API validation, authorization, and actions | `src/server/api.ts`, `src/server/security.ts`, `src/server/attachments.ts` |
| Domain transitions and transaction/persistence boundary | `src/server/state.ts`, `src/server/db.ts` |
| Durable runs, scheduling, concurrency, logs | `src/server/run-repository.ts`, `src/server/worker.ts`, `src/server/scheduler.ts`, `src/server/project-agent-settings.ts`, `src/server/run-logs.ts` |
| Agent prompts/results, sandbox lifecycle, GitHub publication | `src/server/runner.ts`, `src/server/sandbox.ts`, `src/server/preparation.ts`, `src/server/github.ts` |
| Code running inside sandboxes | `sandbox/runner.py`, `sandbox/Dockerfile` |
| App startup, build, deployment | `src/server/index.ts`, `vite.config.ts`, `Dockerfile`, `compose.yaml` |

## Development and verification

Use **npm** with the existing `package-lock.json`. Local app development needs Node.js 22 and reachable PostgreSQL. Python 3.10+ and Git are also needed for the complete test suite. Setup and environment values are documented in README and `.env.example`; preserve an existing `.env` and its `APP_SECRET`.

| Command | Purpose |
| --- | --- |
| `npm ci` | Install the locked dependencies. |
| `npm run dev` | Start Express on port 3000 and Vite on 5173 with `/api` proxied to Express. Use `APP_URL=http://localhost:5173`. |
| `npm run typecheck` | Check application code and TypeScript tests. |
| `npm test` | Run serial Node.js tests, then Python sandbox tests. PostgreSQL cases skip without a test database. |
| `npm run test:node` | Run only the Node.js suite. |
| `npm run test:python` | Run only the Python suite. |
| `npm run build` | Typecheck, then build client and server into `dist/`. |
| `docker compose up --build -d` | Build/run the app, PostgreSQL, and the default Node-based sandbox image. |

Tests use `node:test` and Python `unittest`; client rendering tests use React's server renderer. There is no configured lint script. For a focused Node test:

```sh
node --import tsx --test --test-concurrency=1 tests/security.test.ts
```

For database-backed changes, run integrations against an **isolated disposable PostgreSQL database**, never the database used by the running app. Set both database variables before starting the test process: the pool is constructed at module import, so setting `DATABASE_URL` later is insufficient.

```sh
# Replace this example with your disposable test database's connection string.
export KANGENTIX_TEST_DATABASE_URL='postgresql://test_user:test_password@127.0.0.1:5433/kangentix_test'
DATABASE_URL="$KANGENTIX_TEST_DATABASE_URL" npm test
```

Keep Node test files serial as configured. If recording load-test output, point `KANGENTIX_LOAD_REPORT` to a temporary location rather than adding benchmark files to `docs/`.

For behavior changes, add or update tests that exercise observable outcomes, failure paths, and affected boundaries. Run relevant tests while iterating, then `npm test`, `npm run typecheck`, and `npm run build` before handing off code changes. For documentation-only changes, check accuracy and links; an application rebuild is unnecessary. Report skipped integrations or unavailable live-provider checks explicitly.

## Adding or editing a feature

1. Trace the affected UI, API validation/authorization, shared contracts, persistence, and worker/runner behavior. Implement each affected layer together; update typed fixtures when contracts change.
2. Validate request input with the existing Zod schemas. For protected endpoints, authenticate every requester and check project membership and the required feature permissions at the server boundary, including cached responses, attachments, logs, and paginated history. Check General and Sandbox/model writes independently, including mixed settings requests. Preserve the intended public setup/login/health endpoints.
3. Use `mutate` for state changes and its supplied database client for queue/settings writes that belong in the same transaction. `readState` returns committed snapshots that must not be modified. Keep run lifecycle/log/concurrency operations in their existing repositories rather than embedding them in project JSON.
4. Preserve unsaved client form edits during polling and save acknowledgements. Keep board summaries light; fetch full documents, conversations, and private execution logs through ticket-detail endpoints. Maintain stable pagination and cancellation of stale requests.
5. Update [docs/FEATURES.md](docs/FEATURES.md) for product behavior and README for setup changes. Keep `docs/FEATURES.md` as the single maintained feature guide under `docs/`; screenshot assets such as `docs/home.png` and `docs/ticket.png` also belong there. Edit source files, not generated `dist/`, `node_modules/`, or Python cache files.

## Behavior and execution invariants

- Run one application instance. Preserve the worker's PostgreSQL advisory lock and the existing transaction lock order when changing queue or persistence behavior.
- The Board is continuous Kanban without sprints. New tickets can enter the first workflow step directly or move there from Backlog; any unfinished Board ticket locks workflow structure.
- Tickets are shared without assignees. Require a title and description at creation. Ticket fields and image/Markdown attachments are editable only in Backlog after creation; Done tickets remain read-only with their workflow snapshot and history.
- Only the protected first system account can create projects. Preserve its full access to every project. Hide its identity from other users in responses and reviewer lists without losing its reviewer assignments or approval totals. Keep cached responses safe for each viewer. Users Write may grant only permissions held by the actor; Write includes Read for the same section.
- Project ticket prefixes are editable with General Write permission. Preserve existing ticket numbers and prevent collisions when allocating future numbers.
- Workflow movement is forward and explicit. Completing an agent run never advances the ticket. Preserve version/run checks for approvals and invalidate approvals when their reviewed work changes.
- Allow only one pending/running run per ticket, including discussion responses. Project limits are independent; reservations span preparation through outcome persistence and confirmed sandbox cleanup.
- Capture model provider, model, repository, sandbox settings, and credentials at claim time; concurrency limits are read live. Preserve both saved model keys when switching providers, and use only the selected model key for inference.
- Agent execution and uncertain GitHub publication must not be replayed after an ambiguous failure or lost acknowledgement. Retry only explicitly safe pre-agent preparation failures. Retain ownership/capacity until sandbox termination is confirmed.
- Run agent/repository code only inside the disposable sandbox. GitHub writes occur in the trusted app through validated GitHub API payloads; agents never receive GitHub credentials.
- Encrypt saved credentials, omit them from public payloads/audits, and redact secrets before output splitting, buffering, or truncation. Keep authentication/provider environment setup consistent between the TypeScript runner and Python harness.
- Docker images must work with UID 1000, a read-only root, and writable disposable `/tmp`. Preinstall OS packages and required runtimes at build time. Use the [sandbox-image skill](.agents/skills/sandbox-image/SKILL.md) for image changes; changing the app Dockerfile does not change the agent image.

## Maintain this guidance

Update commands and code paths when the project changes. Keep reusable agent instructions here and detailed feature explanations in `docs/FEATURES.md`. Add directory-specific `AGENTS.md` files only when that area needs distinct instructions; avoid duplicating root rules.

Guidance references: [AGENTS.md format and recommended topics](https://agents.md/) and [official OpenAI documentation on AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md).
