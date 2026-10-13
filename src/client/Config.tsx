import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Code2,
  Cpu,
  ExternalLink,
  Github,
  KeyRound,
  Layers3,
  LockKeyhole,
  Plus,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import type { Member, ModelProvider, Project, ProjectData, Step } from "../shared/types";
import { api, errorMessage } from "./api";
import { randomId } from "./id";
import { requiredApprovalCount } from "../shared/workflow";
import { Avatar, Spinner } from "./ui";
import { concurrentSandboxLimit, projectSettings, settleSettingsSave } from "./project-settings";

export function Config({
  data,
  userId,
  refresh,
  notify,
  setError,
}: {
  data: ProjectData;
  userId: string;
  refresh: () => Promise<void>;
  notify: (value: string) => void;
  setError: (value: string) => void;
}) {
  const project = data.project;
  const [section, setSection] = useState<"settings" | "workflow" | "people">(
    "settings",
  );
  const [busy, setBusy] = useState("");
  const [settings, setSettings] = useState(() => projectSettings(project));
  const settingsBaseline = useRef(JSON.stringify(projectSettings(project)));
  const [ollamaApiKey, setOllamaApiKey] = useState("");
  const [claudeApiKey, setClaudeApiKey] = useState("");
  const [e2bApiKey, setE2bApiKey] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [repositories, setRepositories] = useState<
    { fullName: string; defaultBranch: string }[]
  >([]);
  const [steps, setSteps] = useState<Step[]>(() =>
    structuredClone(project.steps).map((step) => ({
      ...step,
      requiredApprovals: requiredApprovalCount(step),
    })),
  );
  const stepsBaseline = useRef(JSON.stringify(project.steps));
  const pendingStepNameFocus = useRef<string | null>(null);
  useEffect(() => {
    const nextSettings = projectSettings(project);
    const previousSettings = settingsBaseline.current;
    settingsBaseline.current = JSON.stringify(nextSettings);
    setSettings((current) =>
      JSON.stringify(current) === previousSettings ? nextSettings : current,
    );
    const previousSteps = stepsBaseline.current;
    stepsBaseline.current = JSON.stringify(project.steps);
    setSteps((current) =>
      JSON.stringify(current) === previousSteps
        ? structuredClone(project.steps)
        : current,
    );
    // Polling updates untouched forms while preserving unsaved local edits.
  }, [project]);
  const [email, setEmail] = useState("");
  const [memberName, setMemberName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [matches, setMatches] = useState<Member[]>([]);
  const [searched, setSearched] = useState(false);
  async function action(key: string, work: () => Promise<void>) {
    setBusy(key);
    setError("");
    try {
      await work();
      await refresh();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy("");
    }
  }
  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    const maxConcurrentRuns = concurrentSandboxLimit(settings.maxConcurrentRuns);
    if (maxConcurrentRuns === null) {
      setError("Concurrent sandboxes must be a whole number from 1 to 2,147,483,647.");
      return;
    }
    await action("settings", async () => {
      const saved = await api<Project>(`/projects/${project.id}`, "PATCH", {
        ...settings,
        maxConcurrentRuns,
        ...(settings.modelProvider === "ollama" && ollamaApiKey.trim() ? { ollamaApiKey: ollamaApiKey.trim() } : {}),
        ...(settings.modelProvider === "claude" && claudeApiKey.trim() ? { claudeApiKey: claudeApiKey.trim() } : {}),
        ...(e2bApiKey.trim() ? { e2bApiKey: e2bApiKey.trim() } : {}),
      });
      const savedSettings = projectSettings(saved);
      settingsBaseline.current = JSON.stringify(savedSettings);
      setSettings((current) => settleSettingsSave(current, settings, savedSettings));
      if (settings.modelProvider === "ollama")
        setOllamaApiKey((current) => current === ollamaApiKey ? "" : current);
      if (settings.modelProvider === "claude")
        setClaudeApiKey((current) => current === claudeApiKey ? "" : current);
      setE2bApiKey((current) => current === e2bApiKey ? "" : current);
      notify("Project settings saved.");
    });
  }
  async function connectGithub() {
    await action("github", async () => {
      const result = await api<{
        identity: string;
        repositories: { fullName: string; defaultBranch: string }[];
      }>(`/projects/${project.id}/github/connect`, "POST", {
        ...(githubToken.trim() ? { token: githubToken.trim() } : {}),
        ...(settings.repository.trim()
          ? { repository: settings.repository.trim() }
          : {}),
      });
      setRepositories(result.repositories);
      setGithubToken("");
      notify(
        `GitHub connected as ${result.identity}. Select a repository and save settings.`,
      );
    });
  }
  function updateStep(id: string, patch: Partial<Step>) {
    setSteps((current) =>
      current.map((step) => (step.id === id ? { ...step, ...patch } : step)),
    );
  }
  function moveStep(index: number, direction: number) {
    setSteps((current) => {
      const next = index + direction;
      if (index <= 0 || next <= 0 || next >= current.length) return current;
      const values = [...current];
      [values[index], values[next]] = [values[next], values[index]];
      return values;
    });
  }
  function addStep() {
    const id = randomId();
    pendingStepNameFocus.current = id;
    setSteps((current) => [
      ...current,
      {
        id,
        name: "New step",
        kind: "manual",
        instructions: "",
        model: "",
        requiredApprovals: 0,
        approverIds: [],
        includePriorArtifacts: false,
        filename: `step-${id}.md`,
      },
    ]);
  }
  async function saveWorkflow(event: FormEvent) {
    event.preventDefault();
    if (
      steps.some((step) => step.requiredApprovals > step.approverIds.length)
    ) {
      setError(
        "Each step needs at least as many eligible reviewers as required approvals.",
      );
      return;
    }
    await action("workflow", async () => {
      await api(`/projects/${project.id}/workflow`, "PUT", { steps });
      notify(
        data.workflowLocked
          ? "Agent models and instructions saved. Future runs will use these settings."
          : "Workflow saved. Your next ticket will follow these steps.",
      );
    });
  }
  async function searchMember() {
    setBusy("search");
    setError("");
    try {
      setMatches(
        await api<Member[]>(
          `/projects/${project.id}/users?search=${encodeURIComponent(email.trim())}`,
        ),
      );
      setSearched(true);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy("");
    }
  }
  async function addMember(event: FormEvent) {
    event.preventDefault();
    await action("member", async () => {
      await api(`/projects/${project.id}/members`, "POST", {
        email: email.trim(),
        ...(memberName.trim() ? { name: memberName.trim() } : {}),
        ...(password ? { password } : {}),
        role,
      });
      setEmail("");
      setMemberName("");
      setPassword("");
      setRole("member");
      setSearched(false);
      setMatches([]);
      notify("Member added to the project.");
    });
  }
  return (
    <div className="config-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">MAKE SPACE FOR GREAT WORK</span>
          <h1>
            Project config<span className="heading-dot">.</span>
          </h1>
          <p>The people, tools, and workflow behind your next release.</p>
        </div>
        <span className="admin-label">
          <ShieldCheck size={15} />
          Admin access
        </span>
      </div>
      <div className="config-tabs">
        <button
          className={section === "settings" ? "active" : ""}
          onClick={() => {
            setSection("settings");
            setError("");
          }}
        >
          <Settings2 size={16} />
          General & integrations
        </button>
        <button
          className={section === "workflow" ? "active" : ""}
          onClick={() => {
            setSection("workflow");
            setError("");
          }}
        >
          <Layers3 size={16} />
          Workflow
        </button>
        <button
          className={section === "people" ? "active" : ""}
          onClick={() => {
            setSection("people");
            setError("");
          }}
        >
          <Users size={16} />
          People<span className="small-count">{data.members.length}</span>
        </button>
      </div>
      {section === "settings" ? (
        <form onSubmit={saveSettings} className="config-form">
          <section className="config-section">
            <div className="config-section-title">
              <span className="config-icon">
                <Layers3 size={20} />
              </span>
              <div>
                <h2>The essentials</h2>
                <p>Give your project a name and a shared sense of direction.</p>
              </div>
            </div>
            <div className="config-fields">
              <div className="form-grid">
                <label>
                  Project name
                  <input
                    value={settings.name}
                    onChange={(event) =>
                      setSettings({ ...settings, name: event.target.value })
                    }
                    required
                    maxLength={100}
                  />
                </label>
                <label>
                  Ticket prefix
                  <input value={project.key} disabled />
                  <small>Ticket prefixes are permanent.</small>
                </label>
              </div>
              <label>
                Description
                <textarea
                  rows={3}
                  value={settings.description}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      description: event.target.value,
                    })
                  }
                  placeholder="What is this project here to do?"
                />
              </label>
            </div>
          </section>
          <section className="config-section">
            <div className="config-section-title">
              <span className="config-icon">
                <Github size={20} />
              </span>
              <div>
                <h2>GitHub repository</h2>
                <p>The code your agent explores and your team delivers.</p>
              </div>
              {project.githubConnected && (
                <span className="badge accent">
                  <Check size={12} />
                  Connected
                </span>
              )}
            </div>
            <div className="config-fields">
              {project.githubConnected && (
                <div className="connection-card">
                  <Github size={21} />
                  <div>
                    <strong>{project.githubIdentity}</strong>
                    <small>Pull requests are opened by this identity.</small>
                  </div>
                  <span className="connection-dot" />
                </div>
              )}
              <label>
                {project.githubConnected
                  ? "Replace GitHub access token"
                  : "GitHub access token"}
                <input
                  value={githubToken}
                  type="password"
                  autoComplete="off"
                  onChange={(event) => setGithubToken(event.target.value)}
                  placeholder={
                    project.githubConnected
                      ? "Saved securely · leave blank to keep"
                      : "Fine-grained personal or bot account token"
                  }
                />
                <small>
                  Use repository read/write contents and pull request
                  permissions. A dedicated bot account can author your pull
                  requests. GitHub App OAuth onboarding is not available in this
                  release.
                </small>
              </label>
              <div className="form-grid">
                <label>
                  Repository
                  <input
                    list="github-repositories"
                    value={settings.repository}
                    onChange={(event) => {
                      const match = repositories.find(
                        (item) => item.fullName === event.target.value,
                      );
                      setSettings({
                        ...settings,
                        repository: event.target.value,
                        ...(match ? { baseBranch: match.defaultBranch } : {}),
                      });
                    }}
                    placeholder="organization/repository"
                  />
                  <datalist id="github-repositories">
                    {repositories.map((repository) => (
                      <option
                        key={repository.fullName}
                        value={repository.fullName}
                      />
                    ))}
                  </datalist>
                  <small>
                    {repositories.length
                      ? `${repositories.length} accessible repositories loaded. Select one above.`
                      : "Enter owner/repository, or connect to load accessible repositories."}
                  </small>
                </label>
                <label>
                  Base branch
                  <input
                    value={settings.baseBranch}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        baseBranch: event.target.value,
                      })
                    }
                    placeholder="main"
                    required
                  />
                </label>
              </div>
              <button
                type="button"
                className="button"
                onClick={() => void connectGithub()}
                disabled={
                  !!busy || (!githubToken.trim() && !project.githubConnected)
                }
              >
                {busy === "github" ? (
                  <Spinner label="Checking access…" />
                ) : (
                  <>
                    <Github size={15} />
                    {project.githubConnected
                      ? "Verify connection / load repositories"
                      : "Connect GitHub"}
                  </>
                )}
              </button>
            </div>
          </section>
          <section className="config-section">
            <div className="config-section-title">
              <span className="config-icon">
                <Cpu size={20} />
              </span>
              <div>
                <h2>Models & credentials</h2>
                <p>
                  Choose Ollama Cloud or Claude for your model. Claude Code is
                  the coding agent for both providers.
                </p>
              </div>
            </div>
            <div className="config-fields">
              <div className="form-grid">
                <label>
                  Model provider
                  <select
                    value={settings.modelProvider}
                    onChange={(event) => setSettings({ ...settings, modelProvider: event.target.value as ModelProvider })}
                    required
                  >
                    <option value="" disabled>Select a provider</option>
                    <option value="ollama">Ollama Cloud</option>
                    <option value="claude">Claude</option>
                  </select>
                </label>
                <label>
                  Default model
                  <input
                    value={settings.model}
                    onChange={(event) =>
                      setSettings({ ...settings, model: event.target.value })
                    }
                    required
                    placeholder={settings.modelProvider === "claude" ? "Claude model ID or alias" : "nemotron-3-ultra:cloud"}
                  />
                  <small>Use a model supported by the selected provider. Individual steps can override this model.</small>
                </label>
              </div>
              <label>
                {settings.modelProvider === "claude" ? "Claude API key" : "Ollama Cloud API key"}
                <span className="input-with-status">
                  <input
                    type="password"
                    autoComplete="off"
                    value={settings.modelProvider === "claude" ? claudeApiKey : ollamaApiKey}
                    onChange={(event) => settings.modelProvider === "claude" ? setClaudeApiKey(event.target.value) : setOllamaApiKey(event.target.value)}
                    placeholder={
                      (settings.modelProvider === "claude" ? project.hasClaudeKey : project.hasOllamaKey)
                        ? "Saved securely · leave blank to keep"
                        : `Enter your ${settings.modelProvider === "claude" ? "Claude" : "Ollama Cloud"} API key`
                    }
                  />
                  {(settings.modelProvider === "claude" ? project.hasClaudeKey : project.hasOllamaKey) && (
                    <span>
                      <ShieldCheck size={14} />
                      Configured
                    </span>
                  )}
                </span>
                <small>
                  <a href={settings.modelProvider === "claude" ? "https://platform.claude.com/settings/keys" : "https://ollama.com/settings/keys"} target="_blank" rel="noreferrer">
                    Get a {settings.modelProvider === "claude" ? "Claude" : "Ollama Cloud"} API key
                  </a>. Credentials are stored encrypted and are never displayed to project members.
                </small>
              </label>
            </div>
          </section>
          <section className="config-section">
            <div className="config-section-title">
              <span className="config-icon">
                <Code2 size={20} />
              </span>
              <div>
                <h2>Agent sandbox</h2>
                <p>
                  An isolated environment for each run and conversation reply.
                </p>
              </div>
            </div>
            <div className="config-fields">
              <div className="sandbox-options">
                <label
                  className={`sandbox-option ${settings.sandboxProvider === "docker" ? "selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="sandbox"
                    value="docker"
                    checked={settings.sandboxProvider === "docker"}
                    onChange={() =>
                      setSettings({ ...settings, sandboxProvider: "docker" })
                    }
                  />
                  <span>
                    <strong>Docker</strong>
                    <small>Run on your Docker host.</small>
                  </span>
                  <Code2 size={20} />
                </label>
                <label
                  className={`sandbox-option ${settings.sandboxProvider === "e2b" ? "selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="sandbox"
                    value="e2b"
                    checked={settings.sandboxProvider === "e2b"}
                    onChange={() =>
                      setSettings({ ...settings, sandboxProvider: "e2b" })
                    }
                  />
                  <span>
                    <strong>E2B</strong>
                    <small>Managed cloud sandboxes.</small>
                  </span>
                  <Layers3 size={20} />
                </label>
              </div>
              <label>
                Concurrent sandboxes
                <input
                  type="number"
                  min={1}
                  max={2_147_483_647}
                  step={1}
                  required
                  value={settings.maxConcurrentRuns}
                  onChange={(event) =>
                    setSettings({ ...settings, maxConcurrentRuns: event.target.value })
                  }
                />
                <small>
                  Maximum simultaneous agent runs for this project. Default: 100.
                  Additional runs wait in the queue.
                </small>
              </label>
              {settings.sandboxProvider === "docker" ? (
                <label>
                  Docker image
                  <input
                    value={settings.dockerImage}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        dockerImage: event.target.value,
                      })
                    }
                    placeholder="aira-sandbox:latest"
                    required
                  />
                  <small>
                    Use the provided base image or extend it with your project’s
                    dependencies. See the README for the build command.
                  </small>
                </label>
              ) : (
                <>
                  <label>
                    E2B template
                    <input
                      value={settings.e2bTemplate}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          e2bTemplate: event.target.value,
                        })
                      }
                      placeholder="claude (default)"
                    />
                    <small>
                      Leave empty to use claude, or enter a custom template ID
                      with the runtimes your project needs. Setup instructions
                      are in the README.
                    </small>
                  </label>
                  <label>
                    E2B API key
                    <span className="input-with-status">
                      <input
                        type="password"
                        autoComplete="off"
                        value={e2bApiKey}
                        onChange={(event) => setE2bApiKey(event.target.value)}
                        placeholder={
                          project.hasE2bKey
                            ? "Saved securely · leave blank to keep"
                            : "Enter your E2B API key"
                        }
                      />
                      {project.hasE2bKey && (
                        <span>
                          <ShieldCheck size={14} />
                          Configured
                        </span>
                      )}
                    </span>
                  </label>
                </>
              )}
              <div className="info-box">
                <LockKeyhole size={17} />
                <p>
                  Agent steps and conversations inspect a fresh checkout. Enable
                  Create PR from changes on an agent step to publish repository
                  changes and open a pull request.
                </p>
              </div>
            </div>
          </section>
          <div className="config-savebar">
            <span>
              <KeyRound size={14} />
              Leave credential fields blank to keep existing keys.
            </span>
            <button className="button primary" disabled={!!busy}>
              {busy === "settings" ? (
                <Spinner label="Saving…" />
              ) : (
                <>
                  <Save size={15} />
                  Save project settings
                </>
              )}
            </button>
          </div>
        </form>
      ) : section === "workflow" ? (
        <form onSubmit={saveWorkflow} className="workflow-form">
          <div
            className={`info-box ${data.workflowLocked ? "warning-box" : ""}`}
          >
            <LockKeyhole size={18} />
            <div>
              <strong>
                {data.workflowLocked
                  ? "Unfinished sprint tickets lock workflow structure."
                  : "A workflow that fits the way you build."}
              </strong>
              <p>
                {data.workflowLocked
                  ? "Admins can edit and save Model and Agent instructions. All other workflow fields stay locked while the current sprint has unfinished tickets. Finish those tickets or return them to Backlog to unlock the workflow. Agent setting changes apply to future runs."
                  : "Rename the first parking column and add steps for your team. Choose which steps run an agent or create a pull request. All workflow settings are editable when the current sprint is empty or every ticket is Done. With unfinished sprint tickets, only agent models and instructions remain editable."}
              </p>
            </div>
          </div>
          <div className="workflow-preview">
            {steps.map((step, index) => (
              <span key={step.id}>
                <i>{index + 1}</i>
                {step.name}
              </span>
            ))}
          </div>
          <fieldset className="workflow-fieldset" disabled={!!busy}>
            {steps.map((step, index) => (
              <section className="workflow-step" key={step.id}>
                <div className="workflow-step-header">
                  <span className="step-number">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <strong>{step.name || "Untitled step"}</strong>
                    <span>
                      {index === 0
                        ? "The starting point"
                        : step.kind === "implement"
                          ? "Agent · creates a pull request"
                          : step.kind === "definition"
                            ? "Agent · document & collaboration"
                            : "Manual step"}
                    </span>
                  </div>
                  {index === 0 ? (
                    <span className="badge">
                      <LockKeyhole size={11} />
                      Fixed position
                    </span>
                  ) : (
                    <div className="step-order-actions">
                      <button
                        type="button"
                        className="icon-button"
                        title="Move step earlier"
                        aria-label={`Move ${step.name} earlier`}
                        onClick={() => moveStep(index, -1)}
                        disabled={index <= 1 || data.workflowLocked || !!busy}
                      >
                        <ArrowUp size={16} />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        title="Move step later"
                        aria-label={`Move ${step.name} later`}
                        onClick={() => moveStep(index, 1)}
                        disabled={
                          index >= steps.length - 1 ||
                          data.workflowLocked ||
                          !!busy
                        }
                      >
                        <ArrowDown size={16} />
                      </button>
                      <button
                        type="button"
                        className="icon-button danger"
                        title="Remove step"
                        aria-label={`Remove ${step.name}`}
                        onClick={() =>
                          setSteps((current) =>
                            current.filter((item) => item.id !== step.id),
                          )
                        }
                        disabled={data.workflowLocked || !!busy}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  )}
                </div>
                <div className="workflow-step-fields">
                  <div className="form-grid">
                    <label>
                      Step name
                      <input
                        ref={(input) => {
                          if (input && pendingStepNameFocus.current === step.id) {
                            pendingStepNameFocus.current = null;
                            input.focus();
                            input.select();
                          }
                        }}
                        value={step.name}
                        onChange={(event) =>
                          updateStep(step.id, { name: event.target.value })
                        }
                        disabled={data.workflowLocked || !!busy}
                        required
                        maxLength={80}
                      />
                    </label>
                    {(step.kind === "definition" ||
                      step.kind === "implement") && (
                      <label>
                        Model
                        <input
                          value={step.model}
                          onChange={(event) =>
                            updateStep(step.id, { model: event.target.value })
                          }
                          placeholder={project.model}
                          disabled={!!busy}
                        />
                      </label>
                    )}
                  </div>
                  {index > 0 && (
                    <>
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={
                            step.kind === "definition" ||
                            step.kind === "implement"
                          }
                          onChange={(event) =>
                            updateStep(
                              step.id,
                              event.target.checked
                                ? {
                                    kind: "definition",
                                    model: step.model || project.model,
                                    includePriorArtifacts: true,
                                  }
                                : {
                                    kind: "manual",
                                    instructions: "",
                                    model: "",
                                    includePriorArtifacts: false,
                                  },
                            )
                          }
                          disabled={data.workflowLocked || !!busy}
                        />
                        <span>Agent step</span>
                      </label>
                      {step.kind !== "manual" && (
                        <label className="check-row">
                          <input
                            type="checkbox"
                            checked={step.kind === "implement"}
                            onChange={(event) =>
                              updateStep(step.id, {
                                kind: event.target.checked
                                  ? "implement"
                                  : "definition",
                              })
                            }
                            disabled={data.workflowLocked || !!busy}
                          />
                          <span>Create PR from changes</span>
                        </label>
                      )}
                    </>
                  )}
                  {(step.kind === "definition" ||
                    step.kind === "implement") && (
                    <>
                      <label>
                        Agent instructions
                        <textarea
                          rows={4}
                          value={step.instructions}
                          onChange={(event) =>
                            updateStep(step.id, {
                              instructions: event.target.value,
                            })
                          }
                          placeholder="Describe what the agent should investigate or build, and the expected document or implementation."
                          disabled={!!busy}
                        />
                      </label>
                      {step.kind === "definition" && (
                        <p className="form-hint">
                          <FileLabel filename={step.filename} />
                          This stable filename is preserved when you rename the
                          step.
                        </p>
                      )}
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={step.includePriorArtifacts}
                          onChange={(event) =>
                            updateStep(step.id, {
                              includePriorArtifacts: event.target.checked,
                            })
                          }
                          disabled={data.workflowLocked || !!busy}
                        />
                        <span>
                          Include documents from prior steps as agent context
                        </span>
                      </label>
                    </>
                  )}
                  {(step.kind === "sprint" || step.kind === "manual") && (
                    <p className="form-hint">
                      Tickets stay here until the team moves them forward. This
                      step does not run an agent.
                    </p>
                  )}
                  <div className="approval-config">
                    <label>
                      Required approvals
                      <input
                        type="number"
                        value={step.requiredApprovals}
                        min={step.approverIds.length ? 1 : 0}
                        max={step.approverIds.length}
                        disabled={
                          !step.approverIds.length ||
                          data.workflowLocked ||
                          !!busy
                        }
                        onChange={(event) =>
                          updateStep(step.id, {
                            requiredApprovals: Math.min(
                              step.approverIds.length,
                              Math.max(
                                step.approverIds.length ? 1 : 0,
                                Number(event.target.value),
                              ),
                            ),
                          })
                        }
                      />
                      <small>
                        With no reviewers assigned, any project member can
                        advance. Approvals apply when leaving this step.
                      </small>
                    </label>
                    <div className="approver-field">
                      <span className="field-label">Eligible reviewers</span>
                      <div className="approver-options">
                        {data.members.map((member) => (
                          <label
                            className={`approver-option ${step.approverIds.includes(member.id) ? "selected" : ""}`}
                            key={member.id}
                          >
                            <input
                              type="checkbox"
                              checked={step.approverIds.includes(member.id)}
                              onChange={(event) => {
                                const approverIds = event.target.checked
                                  ? [...step.approverIds, member.id]
                                  : step.approverIds.filter(
                                      (id) => id !== member.id,
                                    );
                                updateStep(step.id, {
                                  approverIds,
                                  requiredApprovals: approverIds.length
                                    ? Math.min(
                                        approverIds.length,
                                        Math.max(1, step.requiredApprovals),
                                      )
                                    : 0,
                                });
                              }}
                              disabled={data.workflowLocked || !!busy}
                            />
                            <Avatar small name={member.name} />
                            <span>{member.name}</span>
                          </label>
                        ))}
                      </div>
                      <small>
                        Approvals come from distinct named reviewers. Revisions
                        clear approvals.
                      </small>
                    </div>
                  </div>
                </div>
              </section>
            ))}
            <button
              type="button"
              className="add-step-button"
              onClick={addStep}
              disabled={data.workflowLocked || !!busy}
            >
              <Plus size={17} />
              Add a step
            </button>
          </fieldset>
          <div className="config-savebar">
            <span>
              Tickets in the last step can be marked Done. Done tickets stay on
              the board until the next sprint.
            </span>
            <div className="form-actions">
              <button
                type="button"
                className="button"
                disabled={!!busy}
                onClick={() => {
                  setSteps(
                    structuredClone(project.steps).map((step) => ({
                      ...step,
                      requiredApprovals: requiredApprovalCount(step),
                    })),
                  );
                  setError("");
                }}
              >
                Discard changes
              </button>
              <button className="button primary" disabled={!!busy}>
                {busy === "workflow" ? (
                  <Spinner label="Saving…" />
                ) : (
                  <>
                    <Save size={15} />
                    Save workflow
                  </>
                )}
              </button>
            </div>
          </div>
        </form>
      ) : (
        <div className="people-layout">
          <section className="config-section">
            <div className="config-section-title">
              <span className="config-icon">
                <Users size={20} />
              </span>
              <div>
                <h2>Your project team</h2>
                <p>Shared access to tickets, documents, and conversations.</p>
              </div>
            </div>
            <div className="member-list">
              {data.members.map((member) => (
                <div className="member-row" key={member.id}>
                  <Avatar name={member.name} />
                  <div>
                    <strong>
                      {member.name}
                      {member.id === userId && (
                        <span className="muted"> (you)</span>
                      )}
                    </strong>
                    <small>{member.email}</small>
                  </div>
                  <span
                    className={`badge ${member.role === "admin" ? "accent" : ""}`}
                  >
                    {member.role}
                  </span>
                  <button
                    type="button"
                    className="icon-button danger"
                    title={
                      member.id === userId
                        ? "You cannot remove yourself here"
                        : "Remove from this project"
                    }
                    aria-label={`Remove ${member.name} from project`}
                    disabled={!!busy || member.id === userId}
                    onClick={() =>
                      void action(`remove-${member.id}`, async () => {
                        await api(
                          `/projects/${project.id}/members/${member.id}`,
                          "DELETE",
                        );
                        notify(`${member.name} removed from the project.`);
                      })
                    }
                  >
                    {busy === `remove-${member.id}` ? (
                      <Spinner label="" />
                    ) : (
                      <Trash2 size={15} />
                    )}
                  </button>
                </div>
              ))}
            </div>
          </section>
          <section className="config-section">
            <div className="config-section-title">
              <span className="config-icon">
                <UserPlus size={20} />
              </span>
              <div>
                <h2>Bring someone in</h2>
                <p>Add an existing account or create a new one.</p>
              </div>
            </div>
            <form className="config-fields" onSubmit={addMember}>
              <label>
                Email address
                <div className="inline-field">
                  <input
                    type="email"
                    value={email}
                    onChange={(event) => {
                      setEmail(event.target.value);
                      setSearched(false);
                      setMatches([]);
                    }}
                    placeholder="teammate@company.com"
                    required
                  />
                  <button
                    type="button"
                    className="button"
                    aria-label="Find existing user"
                    onClick={() => void searchMember()}
                    disabled={!!busy || !email.trim()}
                  >
                    {busy === "search" ? (
                      <Spinner label="" />
                    ) : (
                      <Search size={16} />
                    )}
                  </button>
                </div>
                <small>
                  Search by exact email to find an existing account.
                </small>
              </label>
              {searched &&
                (matches.length ? (
                  <div className="member-matches">
                    {matches.map((member) => (
                      <button
                        type="button"
                        className="member-match"
                        key={member.id}
                        onClick={() => {
                          setEmail(member.email);
                          setMemberName(member.name);
                          setPassword("");
                        }}
                      >
                        <Avatar small name={member.name} />
                        <span>
                          <strong>{member.name}</strong>
                          <small>{member.email}</small>
                        </span>
                        <span className="badge">Select</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="form-hint">
                    No existing account found. Enter a name and initial password
                    to create one.
                  </p>
                ))}
              <label>
                Name
                <input
                  value={memberName}
                  onChange={(event) => setMemberName(event.target.value)}
                  maxLength={100}
                  placeholder="Required for a new account"
                />
              </label>
              <label>
                Initial password
                <input
                  type="password"
                  value={password}
                  autoComplete="new-password"
                  onChange={(event) => setPassword(event.target.value)}
                  minLength={12}
                  placeholder="At least 12 characters for a new account"
                />
                <small>
                  New users must change this password at first login. Existing
                  users keep their own password.
                </small>
              </label>
              <label>
                Project role
                <select
                  value={role}
                  onChange={(event) =>
                    setRole(event.target.value as "admin" | "member")
                  }
                >
                  <option value="member">Member</option>
                  <option value="admin">Project admin</option>
                </select>
                <small>
                  {role === "admin"
                    ? "Admins can manage settings, workflow, and people for this project."
                    : "Members can work on tickets and conversations in this project."}
                </small>
              </label>
              <button className="button primary" disabled={!!busy}>
                {busy === "member" ? (
                  <Spinner label="Adding…" />
                ) : (
                  <>
                    <UserPlus size={15} />
                    Add to project
                  </>
                )}
              </button>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
function FileLabel({ filename }: { filename: string }) {
  return <code className="filename-label">{filename}</code>;
}
