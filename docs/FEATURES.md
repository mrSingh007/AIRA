# Kangentix feature guide

Kangentix is a self-hosted agentic Kanban board for bounded agent execution with people in the loop. Teams take software tickets through human work, agent-generated documents, shared review, configured approvals, and GitHub pull requests. Agent runs stay within the current workflow step; people review the results and decide when work advances. The web UI and API run together; PostgreSQL stores accounts, project settings, tickets, documents, conversations, approvals, execution history, and activity. Claude Code runs outside the application in a fresh Docker or E2B sandbox, using the project's selected Ollama Cloud or Claude model provider.

See the [README](../README.md) for the repository overview and [LICENSE](../LICENSE) for the MIT license and credit to Harvinder Mand.

## Run and try Kangentix locally

Install and start Docker Engine with Compose or Docker Desktop. From the repository root:

```sh
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 32
```

Put the first generated secret in `APP_SECRET` and the second in `POSTGRES_PASSWORD` in `.env`. Keep the defaults `KANGENTIX_BIND=127.0.0.1`, `KANGENTIX_PORT=3000`, and `APP_URL=http://localhost:3000` for a local installation. Keep `APP_SECRET` stable: it encrypts stored integration credentials. GitHub, model-provider, and E2B credentials are saved per project in the UI.

```sh
docker compose up --build -d
```

Open **http://localhost:3000**. Compose builds the application and the Node-based `kangentix-sandbox:local` image from [`sandbox/Dockerfile`](../sandbox/Dockerfile), then starts the application and PostgreSQL. The `sandbox-image` service exits successfully after preparing the image; this is expected. Agent runs use Docker by default. Allow at least 4 GiB memory per active agent container, plus application, database, and host overhead.

```sh
docker compose ps
docker compose logs -f app
```

After the initial build, start with `docker compose up -d`. After updating the source, run `docker compose up --build -d` to rebuild and apply the changes, keeping the existing `.env` and `APP_SECRET`. Stop with `docker compose down`; this keeps the `postgres_data` volume. `docker compose down -v` deletes the database volume, including accounts and project history. Back up PostgreSQL together with `APP_SECRET`.

To try a complete workflow, create the initial account and first project, configure GitHub and a model provider, add a document step and a PR step, and create a ticket directly on the Board or add it from Backlog. Advance with **Next step**, review the generated document, approve when required, then review the PR and mark the ticket Done when its workflow is complete. Use a disposable repository for testing publication.

## Accounts, projects, and people

The first visit presents one-time account setup; no default password is shipped. Complete this before exposing the server to others. Sign in with email and password. Accounts assigned an initial password must change it before accessing projects. Sessions expire after seven days, and changing a password revokes that account's existing sessions.

The first account is the protected **system user**. It always has full access and is automatically added to every existing and new project; its project access cannot be removed or reduced. Existing installations promote their original first account without resetting data. Only the system user can create projects, using **Create new project** in the project switcher. Members and accounts without project access cannot create projects; an account without access sees a prompt to ask an administrator to add it to a project. The API enforces these permissions. Accounts must change an assigned initial password before accessing project actions.

Each project has its own name, description, ticket prefix, repository, workflow, integrations, and members. Ticket prefixes contain 2–10 letters or numbers, beginning with a letter, and identify tickets such as `KANG-1`.

Every project member has **Basic (Board, Backlog & Done)** access. This mandatory permission cannot be unchecked, and members remain available as eligible step reviewers. Additional permissions are granted independently for each project:

| Permission | Access |
| --- | --- |
| Analytics | View project analytics. |
| Users — Read | View the full Config → Users page, including the user list and disabled create-user panel; cannot search, add, remove, or change users. |
| Users — Write | Includes Users Read; search and create users, edit their permissions, and remove project access. |
| Workflow — Write | Edit Config → Workflow, including reviewer rules while structure is locked. |
| General — Read / Write | View or edit Config → General: project name, editable ticket prefix, description, and GitHub connection/repository. Prefix changes apply to future ticket numbers; existing ticket numbers remain stable. |
| Sandbox & models — Read / Write | View or edit model providers, default model, model credentials, agent sandbox, and concurrency settings. |

Project administrators retain all project permissions. Other members collaborate on tickets, documents, conversations, approvals, and forward movement. Config shows sections allowed by the member's permissions. Write includes Read for the same section. Users Write is required to grant permissions: if the current user has only Read for a section, they can grant only Read; if they have Write, they can grant Read or Write. General and Sandbox & models saves require their respective Write permissions.

In **Config → Users**, a user with Users Write can find an existing account by exact email or create a new account with a name and initial password, then choose permissions. New users receive mandatory board access by default. A Users Write user can grant only permissions they hold and cannot change or remove someone whose permissions exceed their own. The system user cannot be removed or have its permissions changed. Only the system user sees its own account in user lists or reviewer selectors; other accounts never receive its identity. The system user can select itself as a workflow reviewer. Other users retain those hidden assignments when saving the workflow; approval counts still include approvals from eligible hidden reviewers. Removing a member removes access to that project, rather than deleting their account or history. Invitation email and password-reset email are not available.

The system user and existing administrators automatically have **Analytics** access. In **Config → Users**, users with both Users Write and Analytics can grant or revoke analytics access for members they are allowed to manage. Analytics permission controls visibility for the current project while preserving mandatory Basic access. Reducing an existing administrator's grants converts that account to a member with the selected permissions. Revoked users and nonmembers cannot access the project's analytics API.

## Project settings and integrations

**Config → General** contains project name, editable ticket prefix, description, and GitHub connection/repository. Prefix changes apply to future ticket numbers; existing ticket numbers remain stable. Numbering continues within the project: changing `KANG` to `NEW` after `KANG-1` produces `NEW-2` next, unless that number is already in use. **Config → Sandbox & models** contains Models & credentials and Agent sandbox, including the concurrent sandbox limit. Settings are project-specific. Each section has independent Read and Write permissions; saves enforce the corresponding Write permission on the server. Saved credentials are encrypted and represented by presence indicators rather than returned in API responses. Leave replacement key fields blank to retain saved values.

### Model provider: Ollama Cloud or Claude

Choose **Model provider** and save the corresponding API key. New projects default to **Ollama Cloud**. Claude Code remains the agent interface for either provider; the dropdown selects who supplies model inference.

| Provider | Credential | Model selection |
| --- | --- | --- |
| Ollama Cloud | Create a key in [Ollama account settings](https://ollama.com/settings/keys). | Use a tool-capable hosted model identifier from the [cloud catalog](https://ollama.com/search?c=cloud). A terminal `:cloud` suffix is removed for direct cloud requests. No local Ollama daemon or model download is needed. |
| Claude | Create an API key in [Claude platform settings](https://platform.claude.com/settings/keys). | Use a Claude model alias such as `sonnet`, or a full API model identifier available to your account. API access and charges apply; this configuration uses an API key. |

The form shows the selected provider's API key field. Switching providers preserves both saved keys, while a run uses only its selected model-provider key. The project **Default model** applies to agent steps that have no model override. Set individual models in **Config → Workflow** when needed. Step overrides must work with the project's selected provider; when switching providers, review both the project default and every step override.

Provider errors or invalid structured agent output fail the run and appear in its logs. Kangentix does not substitute simulated output. Ollama's Anthropic-compatible interface supports basic tool calling but not every Anthropic-specific feature or hosted web-search capability; choose models suitable for your workflow and validate them with a small ticket.

### GitHub repository and identity

Connect a fine-grained personal access token from a user or dedicated bot account. Grant the selected repositories **Contents: Read and write** and **Pull requests: Read and write**. Changes to GitHub Actions workflows can also require **Workflows: Read and write**. The token identity must have repository write access; organization approval or SSO authorization may apply.

Kangentix verifies the token identity and repository access before saving credentials. Load accessible repositories, select `owner/repository`, confirm the **Base branch**, and save settings. The connected identity authors pull requests. This release supports github.com tokens; GitHub App OAuth onboarding, installation-token onboarding, and GitHub Enterprise Server are not implemented.

Every agent request resolves the base branch to an exact commit and receives that repository archive. Agents never receive the GitHub token. The trusted app retrieves snapshots and publishes validated changes through the GitHub API.

## Backlog, tickets, and attachments

Create a ticket with a required title, required Markdown description, and **Low**, **Medium**, **High**, or **Urgent** priority. Tickets have no assignee. Use search to match ticket number, title, description, step Markdown documents, or uploaded Markdown content, and filter by priority in the project views.

All ticket fields are editable only in **Backlog**. Backlog details have **Overview** and **Activity** tabs. Select backlog rows to **Add to Board** or **Close — won't do**. Closing from Backlog sends the ticket directly to the Done archive.

Attach up to five images when creating a ticket on the Board or in Backlog. After creation, add or remove images only while the ticket is in Backlog. PNG, JPEG, GIF, and WebP are accepted, up to 2 MiB per image. Images are stored in PostgreSQL and served only to authorized project participants. Ticket Markdown renders authenticated attachments inline; other image URLs appear as links, so merely opening a ticket does not request remote images.

When a ticket enters the Board, its title, description, priority, and attachments become read-only. Each agent run receives image attachments at `docs/kangentix/<TicketNumber>/images/<image-id>.<extension>` with file references in its prompt. Published PRs preserve those images with the selected ticket documents.

Upload up to five UTF-8 Markdown files (`.md` or `.markdown`), up to 2 MiB each, alongside the five-image allowance. Markdown attachments are stored privately, can be downloaded by project participants, contribute to ticket search, and are supplied to agents at `docs/kangentix/<TicketNumber>/attachments/<attachment-id>.md`. Include Markdown uploads when creating tickets on the Board or in Backlog; after creation, add or remove them only in Backlog. Published PRs preserve the uploaded files with the ticket images and selected step documents. The new-ticket dialog supports **Expand** and **Collapse**, with **Close** available in either size.

## Kanban board

The **Agentic Kanban Board** is an ongoing workflow without sprints. **Create new ticket** creates a ticket directly in the first configured step. **Add from Backlog** selects existing backlog tickets and moves them to that step; Backlog also provides **Add to Board** for selected rows. The board shows one column per configured workflow step, ticket priority, approval progress, queued/running/failed status, cleanup status, and PR links. Search highlights matching cards while keeping nonmatching cards visible; priority filtering still narrows the Board. Backlog and Done search filter their ticket lists. The header shows the unique eligible reviewers across configured workflow steps, respecting system-user visibility rules.

An unfinished ticket can **Move to Backlog** when no agent run is pending or running. This clears approvals and step membership while preserving ticket fields, documents, conversations, and run/PR history. Its fields become editable again. Returning it to the Board starts a new work period at the first workflow step.

## Configurable workflow steps

New projects contain only the first **Todo** parking step. Add the remaining stages yourself in **Config → Workflow**; there are no fixed Implement, Review, or QA columns. The first step stays first and retains its identity, but can be renamed while the workflow is unlocked.

| Step configuration | Behavior |
| --- | --- |
| First parking step | Holds newly admitted board tickets. It has no agent model, instructions, or prior-document option. |
| **Agent step** off | Manual stage, for example In QA or Waiting. No sandbox starts. |
| **Agent step** on, **Create PR from changes** off | Generates a Markdown document saved in Kangentix. The agent can read/search the repository but cannot execute shell commands or change repository files. |
| **Agent step** on, **Create PR from changes** on | Lets the agent edit code, install dependencies, build, and test within its sandbox. Kangentix publishes a verified PR, or records a successful no-change result. |

For added steps, choose a name, eligible reviewers, and required approval count. Agent steps also have instructions, an optional model override, and **Include documents from prior steps**. This setting controls whether earlier ticket documents are included in the agent's context. Documents have stable filenames independent of step display names.

You can add, remove, rename, and reorder later steps while the board has no unfinished tickets. Once unfinished board tickets exist, structure stays locked, but users with Workflow Write can still change **eligible reviewers**, **required approvals**, and agent-step **models and instructions**. Changing reviewer rules clears approvals for the affected steps on active tickets so that the new rules must be reviewed. Changes to agent models and instructions preserve approvals and apply to future runs. Done tickets retain their saved workflow and approvals.

Workflow movement on the Board is forward. **Next step** checks the current step's work and approvals, then moves the ticket. Entering an agent step queues its initial run. Completing a run does not automatically advance a ticket.

## Documents and agent discussions

Each document step stores one versioned Markdown document. On the current step, project members can **Edit** or **Write** it directly, or **Generate / Rerun** the agent. Earlier-step documents are read-only after advancement.

Document steps support independent discussion threads. A new prompt creates a thread; follow-up messages use that thread's stored history and selected ticket documents. The conversation is visible to project participants. Ask questions or request revisions to the current document. Document changes, including agent revisions, clear that step's approvals.

Every response runs in a new sandbox. Continuity comes from saved messages and documents, rather than a persistent shell session or checkout. Document/discussion agents have only Claude Code's `Read`, `Glob`, and `Grep` tools. Discussions are available on the current document step; archived and earlier-step conversations remain readable.

Concurrent document edits use version checks. If another participant changed the document, refresh and review the updated content before saving or approving.

## Human approvals

Approvals gate leaving the current step. Configure explicitly eligible project participants and the required number of distinct approvals. Assigning reviewers requires at least one approval, and the required count cannot exceed the number of eligible reviewers. Self-approval is allowed. Reviewers may revoke their own approval.

Without assigned reviewers, any project member can advance after the step's work completes. With reviewers, the required distinct eligible approvals must be present. Manual steps can also require approval.

Document approvals refer to the version the reviewer loaded; PR-step approvals refer to the latest successful run. If the work changed, Kangentix rejects the stale approval instead of approving unseen output. Saving/revising a document or rerunning an agent invalidates approvals. Review the new version and approve again.

## Code changes and pull requests

PR steps use a disposable checkout of the captured base commit. The agent receives ticket context and selected documents under `docs/kangentix/<TicketNumber>/<stable-step-filename>.md`. It runs Claude Code with permission prompts skipped inside the sandbox, allowing file editing, shell commands, dependency installation, builds, and tests.

The app validates the resulting changed-file payload, creates Git objects and a run-specific branch through GitHub, opens the PR, and verifies its repository, branch, base, expected tree, and base commit parent. Selected saved documents are enforced again at publication so agent edits cannot silently replace the reviewed inputs. The app does not execute agent-produced code or Git configuration on its host.

PR numbers and links remain on the ticket with step/run history. Multiple runs may create multiple PRs. A successful run with no repository diff records **no changes** and does not require a PR. A failed run stays in its current step and can be retried. A branch can remain when branch publication succeeds but PR creation fails; check GitHub before cleaning it up. A retry uses a new run branch.

Binary files, executable file modes, and safe symbolic links are supported. Unsafe paths and links escaping the repository are rejected. Git submodules and Git LFS content downloads are not supported.

PR merging is a separate action in GitHub. Marking a ticket Done does not merge its PR.

## Execution, logs, activity, and recovery

Open a board ticket's **Execution** tab to inspect every agent run, including discussion responses. Runs are **pending**, **running**, **completed**, or **failed**. Expand a run to see its saved logs; active logs update by polling. Use **Run step**, **Retry step**, or document **Rerun** when available. Only one pending/running run is allowed per ticket, including discussion responses.

Logs include assistant progress, tool inputs, commands and file paths, and bounded result excerpts. Known credentials are redacted before buffering/truncation; hidden model reasoning is not saved. The retained log tail is bounded to 200,000 characters, and omitted details are explicitly marked. Ticket **Activity** records changes, decisions, and workflow actions. Execution and activity history load in pages, while selected-ticket details retain full documents and conversations.

Sandbox cleanup runs after success, failure, and no-change results. A visible **cleanup pending** state means termination has not yet been confirmed; it continues to reserve the original project's capacity. Cleanup retries do not rerun the agent.

Queued jobs survive an application restart. Interrupted running jobs fail with an explicit uncertainty warning; inspect their logs and GitHub before retrying, because external publication may already have occurred. Startup reconciles owned resources and cleanup reservations before admitting new work. Shutdown stops new claims, drains briefly, then cancels remaining work and finalizes cleanup.

## Done and the archive

At the final configured step, use **Mark as Done** after work and approvals are complete. A PR need not be merged to complete the workflow. Done tickets are fully read-only and preserve a workflow snapshot, documents, conversations, approvals, run logs, activity, and PR references.

Marking a ticket Done removes it from the active board and moves it to the **Done** archive immediately. Backlog tickets closed as won't do also appear in that archive immediately. Agent completion never advances or completes a ticket automatically.

## Project analytics

Open **Analytics** in the sidebar to review delivery counts and timing metrics for the selected project. The system user and existing administrators have access automatically; other members see this view when granted Analytics permission in **Config → Users**. The API checks current project membership and analytics permission on every request.

Completed delivery counts include tickets marked Done through their workflow; backlog tickets closed as won't do are excluded. Average completion time measures the current work period from Board entry to Done. Median completion time and creation-to-Done lead time are also shown. Active age measures elapsed time since an unfinished ticket entered the Board. Returning a ticket to Backlog resets its work-period start; later Board entry starts a new work period.

Average close rate is the number of workflow deliveries in the rolling last **28 days**, divided by **four weeks**, including weeks with no deliveries. The view shows the period and delivery count. It is separate from completion duration. Counts by Low, Medium, High, and Urgent priority show Backlog, unfinished Board tickets, and their combined total; Done tickets are excluded. The Board total includes all unfinished board tickets.

Summary metrics include all relevant tickets. Detail lists show up to the 500 latest delivered tickets and the 500 oldest active tickets. Missing or invalid timing values appear as unavailable and are excluded from timing averages.

## Docker sandboxes and custom runtimes

Docker is the default sandbox provider. The supplied `kangentix-sandbox:local` image uses **Node.js 22** with npm, Claude Code, Python, Git, ripgrep, build tools, Electron Linux libraries, fonts, and Xvfb. It is the initial Node-based environment, rather than a complete toolchain for every repository. The runner supplies a virtual display when Xvfb is available. Docker sets `ELECTRON_DISABLE_SANDBOX=1` for Electron's nested Chromium sandbox; outer container isolation remains enabled.

Each run gets a fresh container with UID 1000, a read-only root filesystem, disposable 2 GiB `/tmp`, all Linux capabilities dropped, no privilege escalation, a 256-process limit, two CPUs, and 4 GiB memory. Agent containers have no application/database mounts, Docker socket, GitHub token, or E2B key. They use Docker's default bridge, outside the private database network, with outbound access for model inference and dependency downloads. Selective public-network egress restrictions are not implemented.

For Java, Python projects needing `uv`, or other runtimes/libraries, build your own image on the same Docker daemon used by Kangentix and select its tag in **Config → Sandbox & models → Agent sandbox → Docker image**. For example, if the repository targets Java 17:

```dockerfile
FROM kangentix-sandbox:local
USER root
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jdk \
    && rm -rf /var/lib/apt/lists/*
USER node
```

```sh
docker build -t my-project-sandbox:local -f Dockerfile.sandbox .
```

Custom images must support UID 1000 and have `python3`, `git`, and `claude` on `PATH`. Retain Node.js/npm for Claude Code. Install system packages, runtimes, and build tools at image build time; the agent cannot write OS packages into the read-only root. Redirect runtime caches and dependency installation to `/tmp`. There are no persistent caches between runs.

The repository's [sandbox-image skill](../.agents/skills/sandbox-image/SKILL.md) guides runtime selection, Java build tools, Python/`uv`, dependency preinstallation, and verification. Invoke `$sandbox-image` and describe the repository's language, version, and build/test commands. Set `CLAUDE_CODE_VERSION` in `.env` before rebuilding to pin the CLI.

The trusted app mounts the Docker socket to create and remove agent containers. Socket access gives control of the Docker host; use a dedicated trusted deployment and administrator-selected images. Set `DOCKER_SOCKET` for a nonstandard socket location. File transfer uses Docker commands rather than host checkout mounts.

## E2B hosted sandboxes

Select **E2B** in **Config → Sandbox & models → Agent sandbox** when local Docker execution is not needed. Save an [E2B API key](https://e2b.dev/dashboard) and optionally a prepared template ID.

The default template is `claude`; an empty template field also selects `claude`. A custom template must include `node`, `npm`, `python3`, and `git`, support the non-root `user` account and writable `/tmp`, and provide the runtimes and libraries your repository needs. Preinstall Claude Code for faster startup; Kangentix installs it into `/tmp` if it is missing. See [E2B templates](https://docs.e2b.dev/sandbox-template).

Kangentix uploads the snapshot and ticket context, runs the same harness, retrieves bounded results, and kills the sandbox during cleanup. E2B receives repository source and the selected model credential, but not GitHub, database, or application secrets. E2B charges and quotas apply; each response uses a fresh sandbox.

Compose still builds the Docker sandbox image by default. For an E2B-only installation, remove the app's Docker socket mount, its `sandbox-image` dependency, and the `sandbox-image` service from your deployment configuration. Docker can still host the app and database while E2B executes the agents.

## Concurrency and execution limits

Administrators set **Concurrent sandboxes** independently per project for either sandbox provider. The default is **100**; accepted integer values range from 1 to 2,147,483,647. Saving a limit affects subsequent admission immediately. Lowering it does not cancel active runs; queued jobs wait until capacity is available.

Admission rotates fairly between eligible projects and follows queue order within each project. Reservations cover preparation, execution, outcome persistence, and cleanup. There is no application-wide ceiling shared across projects: two projects at default limits can admit 200 jobs. Captured provider, repository, model, and credentials stay fixed for a claimed run; future claims use updated settings.

Repository preparation has a separate fair gate of four transfers. Immutable archives are shared only for the same commit and credential scope, with a 100 MiB per-archive and 400 MiB managed disk-cache bound. GitHub publication is serialized by credential scope. Explicit safe pre-agent capacity/throttle failures can be delayed and retried; agent execution and uncertain publication are not blindly replayed.

| Limit | Current value |
| --- | --- |
| Agent timeout | 15 minutes by default; `RUN_TIMEOUT_SECONDS` is bounded to 1–50 minutes. |
| Repository tree | 30,000 entries. |
| Repository archive | 100 MiB compressed; 500 MiB expanded. |
| Published implementation output | 500 changed files; 5 MiB per file; 20 MiB total. |
| Markdown document | Manual saves: 500,000 characters; generated documents: 500,000 UTF-8 bytes. |
| Combined prompt context | 2 MiB. |
| Ticket images | Five images; 2 MiB each. |
| Ticket Markdown attachments | Five UTF-8 files; 2 MiB each. |
| Docker runtime resources | Two CPUs, 4 GiB memory, 2 GiB `/tmp`, 256 processes per container. |

Oversized or unsupported inputs fail explicitly. An application concurrency setting does not reserve host resources, E2B quotas, model capacity, or GitHub rate limits. One hundred fully loaded Docker agents can demand up to 400 GiB container memory and 200 CPU equivalents before host/app/database overhead. Size capacity for the combined demand of every project and measured workloads; real 100-sandbox provider capacity is not established by the application limit.

## Appearance

The sidebar lists Board, Backlog, Done, Analytics, and Config according to access, with a project switcher above and theme/account controls below. The logo tagline is “Define with your team. Build with your agent.” A shared footer reads “Every step, decision, and conversation stays with your ticket.” and links Kangentix to its repository. Licensing remains MIT.

Choose **Light** or **Dark** under **Appearance** in the sidebar or sign-in screen. Dark is the default. The selection persists in browser local storage across reloads/sign-ins and is shared with tabs on the same origin. It is not an account or project setting and does not follow you to another browser.

On desktop, collapse or expand the sidebar to adjust the space available for the board. This preference persists in session storage for the current browser tab session. On mobile, navigation remains a drawer opened from the menu control.

## Deployment, data, and security

Run **one application instance** with PostgreSQL; a database advisory lock prevents a second worker. Queue state and bounded logs have dedicated durable storage. Tickets, artifacts, conversations, approvals, and audits persist in operational tables; account/project settings and credentials are retained separately. Horizontal workers and streaming log subscriptions are not available.

For shared use, put Kangentix behind HTTPS and set `APP_URL` to the exact public origin without a path or query. HTTPS enables Secure session cookies; `COOKIE_SECURE=true` can force them. API writes require JSON and reject conflicting origin/cross-site metadata. Enable `TRUST_PROXY=true` only behind one trusted reverse proxy that replaces incoming forwarding headers, with the app port inaccessible directly. Keep `.env` private and retain database/encryption-key backups.

Treat repositories, instructions, participants, and custom images as trusted. Implementation code can execute commands and use outbound networking inside its sandbox. The selected model credential must be available there for inference and could be misused by untrusted code. GitHub write credentials remain in the app. Source/prompts are sent to the chosen model service; selecting E2B also sends source to E2B. Docker socket access belongs only to the trusted app.

## Develop and run automated tests

For development outside the app container, use Node.js 22 and a reachable PostgreSQL server. Configure `DATABASE_URL`, a generated `APP_SECRET`, and `APP_URL=http://localhost:5173` in `.env`. Compose's database does not publish a host port; use your own local database or a local-only Compose override.

```sh
npm ci
npm run dev
```

Vite serves the UI on port 5173 and proxies API calls to the backend on port 3000. For Docker agent runs, build `kangentix-sandbox:local` using `sandbox/Dockerfile`. Build and run production with `npm run build` and `npm start`.

```sh
npm test
npm run typecheck
npm run build
```

The complete test command requires Python 3.10+ and Git in addition to Node.js. Select one suite with `npm run test:node` or `npm run test:python`. PostgreSQL integration tests are skipped unless an isolated disposable `KANGENTIX_TEST_DATABASE_URL` is supplied. Set `DATABASE_URL` to that same database before application modules are imported:

```sh
DATABASE_URL="$KANGENTIX_TEST_DATABASE_URL" npm test
```

Automated coverage includes workflow and approval rules, project authorization, direct Board creation, Markdown and image attachments, document search, scheduling and concurrency, persistence/recovery, preparation/cancellation, GitHub result validation, sandbox contracts/path safety, client polling/settings, and log bounds/redaction. Live provider execution, model behavior, GitHub permissions, and infrastructure capacity still need testing with suitable credentials and disposable repositories.
