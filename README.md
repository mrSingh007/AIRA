# Kangentix

<img src="public/kangentix-logo.svg" alt="Kangentix logo" width="80" height="80" />

### Agentic Board · Agentic Kanban

**Bounded agentic workflows, with humans in the loop.**

Kangentix is an open-source Kanban board that brings AI agents into your team's delivery workflow. Take an idea from a shared backlog through specifications, design, implementation, and review—all on one board.

Agents help write documents and prepare code changes. Your team discusses the work, requests revisions, and approves each configured step before moving forward. Everyone shares the same context, while you decide which reviewers and approvals each stage needs. Agent execution stays within defined sandbox, time, and resource limits; progression stays with people.

[Quick start](#quick-start) · [Features](#features) · [Model providers](#model-providers) · [Sandbox configuration](#sandbox-configuration) · [Feature guide](docs/FEATURES.md) · [Contributing](#contributing) · [MIT license](LICENSE)

## Screenshots

The screenshots below show an earlier development build. Labels and layout may differ from the current Kanban interface.

### Team Kanban board

Track tickets across your workflow, with priorities, agent status, and approval progress visible to the team.

[Watch the Kanban board demo on YouTube](https://www.youtube.com/watch?v=ksMT3OKyH_k)

### Documents, discussions, and approvals

Review step documents, discuss changes with the agent, inspect execution history, and approve work from the ticket view.

![Kangentix ticket detail showing a design document, team conversation, execution history, and step approval controls](docs/ticket.png)

## Quick start

Run Kangentix locally with Docker Engine and the Compose plugin, or Docker Desktop. Allow at least 4 GiB of memory per active Docker agent container, plus the app and database.

From the repository root, create your environment file and generate two separate secrets:

```sh
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 32
```

Edit `.env`: use the first generated value for `APP_SECRET` and the second for `POSTGRES_PASSWORD`. Keep these defaults for local use:

```dotenv
KANGENTIX_BIND=127.0.0.1
KANGENTIX_PORT=3000
APP_URL=http://localhost:3000
```

Keep `APP_SECRET` stable: it encrypts saved project credentials. If you change the port, update both `KANGENTIX_PORT` and `APP_URL`.

Build and start the application:

```sh
docker compose up --build -d
```

Open **[http://localhost:3000](http://localhost:3000)**. Compose builds the app and the provided Node-based sandbox image, starts PostgreSQL, and waits for database readiness. The `sandbox-image` service exits successfully after building the image; this is expected.

### Configure your first project

1. Create the initial account, then create a project.
2. In **Config → General**, connect GitHub, select a repository, and confirm its base branch.
3. Under **Config → Sandbox & models → Models & credentials**, select **Ollama Cloud** or **Claude**, save its API key, and enter a supported default model.
4. Under **Config → Sandbox & models → Agent sandbox**, use the default Docker image or configure E2B.
5. In **Config → Users**, add team members and choose their project permissions. In **Config → Workflow**, configure steps, agent instructions, reviewers, and approval counts. New projects start with **Todo**; you add the remaining stages.
6. Create tickets on the Board or add selected backlog tickets to the Board, and use **Next step** to move a ticket through the workflow.

Try your first agent workflow with a small ticket and a disposable repository. Completing an agent run does not automatically advance the ticket, and marking a ticket Done does not merge its pull request.

The initial setup account is the protected system user, with full access to every existing and new project. Its project access cannot be removed or reduced. Only the system user can create projects through the project switcher. Members and accounts without project access cannot create projects; accounts without access are prompted to ask an administrator to add them to a project. The API enforces these permissions.

Every member has **Basic (Board, Backlog & Done)** access and can be selected as a step reviewer. General, Sandbox & models, and Users each have separate Read and Write permissions; Workflow Write and Analytics are granted independently. Users Read shows the full Users page with editing and creation disabled. Users Write can grant only permissions the current user holds. The system account is visible only to itself, including in reviewer lists; its hidden reviewer assignments and approvals remain effective. See [accounts and permissions](docs/FEATURES.md#accounts-projects-and-people) for details.

### Manage the local installation

```sh
docker compose ps
docker compose logs -f app
```

After the initial build, use `docker compose up -d` to start and `docker compose down` to stop. After updating the source, run `docker compose up --build -d` to rebuild and apply the changes; keep the existing `.env` and `APP_SECRET`. The `postgres_data` volume retains accounts, settings, tickets, and history. `docker compose down -v` deletes that data. Back up PostgreSQL together with `APP_SECRET`.

## Features

- **Shared Kanban:** create tickets directly on an ongoing board or move them from Backlog, without sprints. Marking a ticket Done moves it to the searchable Done archive immediately.
- **Ticket search and attachments:** search ticket text, step documents, and uploaded Markdown; Board search highlights matches. Attach up to five images and five Markdown files, each up to 2 MiB, when creating tickets on the Board or in Backlog.
- **Project analytics:** view completion time, weekly close rate, and priority counts across Backlog and Board; access is granted per project through Users permissions.
- **Configurable workflows:** combine manual stages, agent-generated documents, and implementation steps that create GitHub pull requests.
- **Human review and approval:** assign eligible reviewers and approval counts per step; changes invalidate previous approvals so the team reviews the current work.
- **Collaborative documents:** edit versioned Markdown, ask the agent questions, and request revisions in independent discussion threads.
- **Repository context and attachments:** give agents a fresh base-branch snapshot, selected prior documents, and ticket image or Markdown attachments.
- **Execution visibility:** inspect run status, redacted logs, activity, cleanup state, and paginated history from each ticket.
- **Project-specific configuration:** manage membership, model providers, sandbox providers, and concurrency limits independently per project.
- **Light and dark themes:** choose your preferred appearance in the browser. Collapse or expand the desktop sidebar; its state persists for the browser tab session.

A workflow can look like this:

```text
Backlog → Todo → Specification → Design → Implementation → QA → Done
```

You choose the stages and which ones use agents. Configure approvals where the team needs a checkpoint; people review the output and explicitly advance the ticket. See [the feature guide](docs/FEATURES.md) for workflow rules, document versioning, approvals, recovery, and limits.

## Model providers

Claude Code is the coding agent for both supported model providers. Choose one under **Config → Sandbox & models → Models & credentials → Model provider**:

| Provider | API key | Model selection |
| --- | --- | --- |
| **Ollama Cloud** | [Create an Ollama key](https://ollama.com/settings/keys) | Use a tool-capable hosted model from the [cloud catalog](https://ollama.com/search?c=cloud). A terminal `:cloud` suffix is removed for direct requests. |
| **Claude** | [Create a Claude key](https://platform.claude.com/settings/keys) | Use a supported Claude model ID or Claude Code alias, such as `sonnet`. |

Keys are stored encrypted and are not returned in project responses. Leaving a key field blank preserves the saved value. Switching providers keeps both saved keys; runs use the selected provider's key. Review your default model and step overrides when switching providers.

Ollama Cloud runs directly through its hosted API; no local Ollama daemon or model download is needed. Claude uses the Anthropic API. Both providers work with Docker or E2B sandboxes.

## Sandbox configuration

### Docker

Docker is the default provider. Compose builds **`kangentix-sandbox:local`** from [`sandbox/Dockerfile`](sandbox/Dockerfile). The provided image includes Node.js 22, npm, Claude Code, Python, Git, build tools, and libraries for browser/Electron testing.

Each run uses a fresh non-root container with a read-only root filesystem, writable disposable `/tmp`, and time/resource limits. Agent containers have no application/database mounts, Docker socket, or GitHub credentials.

For Java, Python projects that require `uv`, or other stacks with additional runtimes and libraries, build a custom image on the same Docker daemon Kangentix uses:

```sh
docker build -t my-project-sandbox:local -f Dockerfile.sandbox .
```

Set the image tag under **Config → Sandbox & models → Agent sandbox → Docker image**. Install OS packages and runtimes during the image build; runtime caches and dependency installations must use `/tmp`. The repository's [sandbox-image skill](.agents/skills/sandbox-image/SKILL.md) provides Java/Python examples and compatibility checks. Invoke `$sandbox-image` with your project's language, runtime version, and build/test commands.

### E2B

For hosted execution, select **E2B** under **Config → Sandbox & models → Agent sandbox** and save an [E2B API key](https://e2b.dev/dashboard). Kangentix uses the `claude` template by default, including when the template field is empty. You can provide a custom template ID for the runtimes and libraries your project needs; Kangentix installs Claude Code when it is missing.

The supplied Compose file still builds the Docker sandbox image. For an E2B-only installation, see [E2B setup in the feature guide](docs/FEATURES.md#e2b-hosted-sandboxes).

## GitHub integration

Connect a fine-grained personal access token from your account or a dedicated bot account. The selected repositories need **Contents: Read and write** and **Pull requests: Read and write**; changes to GitHub Actions workflows may also need **Workflows: Read and write**.

Agents prepare changes inside the sandbox. The trusted app validates those changes and publishes a verified PR through the GitHub API. The GitHub token stays in the app. PR links and run history remain on the ticket, and merging remains a separate action in GitHub.

## Architecture and deployment

| Component | Role |
| --- | --- |
| React + Vite | Board, project configuration, ticket documents, discussions, and approvals. |
| Express + TypeScript | Authentication, project permissions, workflow actions, scheduling, and integrations. |
| PostgreSQL | Accounts, encrypted credentials, settings, tickets, documents, conversations, approvals, runs, logs, and history. |
| Docker or E2B | Disposable environments for Claude Code and repository build/test commands. |

Run one app instance. For shared use, put Kangentix behind HTTPS and set `APP_URL` to its exact public origin. The trusted app's Docker socket access gives control of the Docker host; use a trusted deployment and administrator-selected images.

Sandbox implementation steps can execute commands and access the network. Source and prompts go to your selected model provider; E2B also receives source when selected. The model key is available inside the sandbox for inference, so repositories, instructions, and participants should be trusted. GitHub write credentials remain in the app.

Concurrency is configurable per project and defaults to 100. This is an application limit, not reserved infrastructure capacity: set it to fit your host resources and provider quotas. See [the feature guide](docs/FEATURES.md#concurrency-and-execution-limits) for resource limits and deployment details.

## Contributing

Contributions to workflows, integrations, accessibility, tests, and documentation are welcome. For implementation guidance and project conventions, read [AGENTS.md](AGENTS.md).

### Local development

Use Node.js 22 and a reachable PostgreSQL server. Configure `DATABASE_URL`, a generated `APP_SECRET`, and `APP_URL=http://localhost:5173` in `.env`. The Compose database has no published host port; use a local database or a local-only Compose override.

```sh
npm ci
npm run dev
```

Vite serves the UI on port 5173 and proxies `/api` to Express on port 3000. Build the default sandbox separately when running Docker agents outside Compose:

```sh
docker build -t kangentix-sandbox:local -f sandbox/Dockerfile .
```

### Tests and production build

The complete test suite also needs Python 3.10+ and Git.

```sh
npm test
npm run typecheck
npm run build
```

Use `npm run test:node` or `npm run test:python` to run one suite. PostgreSQL integration tests skip without an isolated disposable test database. Set both variables before the test process starts:

```sh
export KANGENTIX_TEST_DATABASE_URL='postgresql://test_user:test_password@127.0.0.1:5433/kangentix_test'
DATABASE_URL="$KANGENTIX_TEST_DATABASE_URL" npm test
```

The concurrency integration test runs the full 100-developer workload and records latency measurements. Its default p95 latency limit is 1,000 ms. GitHub CI uses a 5,000 ms guardrail on shared hosted runners. Set `KANGENTIX_LOAD_MAX_P95_MS` to a positive value up to 15,000 ms to choose a limit for your test environment; the selected limit is included in the load report. All correctness checks and the workload run with either limit.

Replace the example URL with your test database's connection string. Keep it separate from your running application's database. Start the compiled application with `npm start`.

## Author and license

Created by **Harvinder Mand**. Kangentix is available under the [MIT License](LICENSE): free to use, modify, and redistribute, including commercially, while retaining the copyright and permission notices.
