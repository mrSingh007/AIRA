import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Archive,
  BarChart3,
  PanelLeftClose,
  PanelLeftOpen,
  Check,
  ChevronRight,
  Circle,
  CircleDot,
  Code2,
  FolderPlus,
  GitBranch,
  GitPullRequest,
  Layers3,
  Bot,
  Maximize2,
  Minimize2,
  ListTodo,
  LogOut,
  Menu,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  X,
  Zap,
} from "lucide-react";
import type {
  Project,
  ProjectData,
  SessionData,
  Ticket,
} from "../shared/types";
import { hasProjectPermission } from "../shared/permissions";
import { api, ApiError, dateLabel, errorMessage, remembered } from "./api";
import { Avatar, Brand, EmptyState, ErrorNotice, Modal, Spinner } from "./ui";
import { Config } from "./Config";
import { Analytics } from "./Analytics";
import { readSidebarCollapsed, saveSidebarCollapsed } from "./sidebar-state";
import { doneTickets, boardTickets } from "./board-tickets";
import { TicketDetail } from "./TicketDetail";
import { ThemeToggle } from "./ThemeProvider";
import { TicketImages, type ImageDraft } from "./TicketImages";
import { requiredApprovalCount } from "../shared/workflow";

type View = "board" | "backlog" | "done" | "config" | "analytics";

export default function App() {
  const [session, setSession] = useState<SessionData | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState("");
  const boot = useCallback(async () => {
    setBooting(true);
    setBootError("");
    try {
      const status = await api<{ needsSetup: boolean }>("/auth/status");
      setNeedsSetup(status.needsSetup);
      if (!status.needsSetup) {
        try {
          setSession(await api<SessionData>("/auth/me"));
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 401)) throw error;
        }
      }
    } catch (error) {
      setBootError(errorMessage(error));
    } finally {
      setBooting(false);
    }
  }, []);
  useEffect(() => {
    void boot();
  }, [boot]);
  if (booting)
    return (
      <div className="boot">
        <Brand />
        <Spinner label="Opening your projects…" />
      </div>
    );
  if (bootError)
    return (
      <div className="boot">
        <Brand />
        <ErrorNotice message={bootError} />
        <button className="button primary" onClick={() => void boot()}>
          Try again
        </button>
      </div>
    );
  if (!session)
    return (
      <Auth
        setup={needsSetup}
        complete={(value) => {
          setSession(value);
          setNeedsSetup(false);
        }}
      />
    );
  if (session.user.mustChangePassword)
    return <PasswordReset complete={setSession} />;
  return (
    <ProjectsApp
      session={session}
      setSession={setSession}
      logout={() => setSession(null)}
    />
  );
}

function Auth({
  setup,
  complete,
}: {
  setup: boolean;
  complete: (value: SessionData) => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      complete(
        await api<SessionData>(
          `/auth/${setup ? "setup" : "login"}`,
          "POST",
          values,
        ),
      );
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-layout">
      <div className="theme-floating">
        <ThemeToggle />
      </div>
      <aside className="auth-story">
        <Brand />
        <div className="auth-message">
          <span className="eyebrow">SOFTWARE, IN MOTION</span>
          <h1>
            Big ideas.
            <br />
            Clear steps.
            <br />
            <em>Real progress.</em>
          </h1>
          <p>
            Your team’s thinking, your agent’s work, and every decision along
            the way. One shared place to ship.
          </p>
          <div className="journey">
            <span>
              <CircleDot size={16} /> Define
            </span>
            <ChevronRight size={14} />
            <span>
              <ShieldCheck size={16} /> Approve
            </span>
            <ChevronRight size={14} />
            <span>
              <GitPullRequest size={16} /> Deliver
            </span>
          </div>
        </div>
        <span className="auth-foot">Built for thoughtful teams.</span>
      </aside>
      <main className="auth-form">
        <div className="auth-form-inner">
          <div className="mobile-brand">
            <Brand />
          </div>
          <span className="eyebrow">
            {setup ? "MAKE IT YOURS" : "WELCOME BACK"}
          </span>
          <h2>{setup ? "Start something great." : "Back to building."}</h2>
          <p className="muted">
            {setup
              ? "Create the first account to start your team’s projects."
              : "Sign in to continue to your projects."}
          </p>
          <form onSubmit={submit}>
            <ErrorNotice message={error} />
            {setup && (
              <label>
                Your name
                <input
                  name="name"
                  autoComplete="name"
                  placeholder="Alex Morgan"
                  required
                  maxLength={100}
                />
              </label>
            )}
            <label>
              Email address
              <input
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                required
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                autoComplete={setup ? "new-password" : "current-password"}
                placeholder={
                  setup ? "At least 12 characters" : "Enter your password"
                }
                minLength={setup ? 12 : undefined}
                required
              />
            </label>
            <button className="button primary full" disabled={busy}>
              {busy ? (
                <Spinner label={setup ? "Creating account…" : "Signing in…"} />
              ) : (
                <>
                  {setup ? "Create your account" : "Sign in"}
                  <ArrowRight size={17} />
                </>
              )}
            </button>
          </form>
          <p className="auth-help">
            {setup
              ? "You’ll create your first project next."
              : "Need an account? Ask a project administrator to invite you."}
          </p>
        </div>
      </main>
    </div>
  );
}

function PasswordReset({
  complete,
}: {
  complete: (value: SessionData) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (values.newPassword !== values.confirm) {
      setError("The new passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      complete(
        await api<SessionData>("/auth/password", "POST", {
          currentPassword: values.currentPassword,
          newPassword: values.newPassword,
        }),
      );
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="center-page">
      <div className="theme-floating">
        <ThemeToggle />
      </div>
      <div className="onboarding-card">
        <Brand />
        <div className="section-icon">
          <ShieldCheck />
        </div>
        <h1>Make your account yours.</h1>
        <p className="muted">
          Choose a new password before opening your projects.
        </p>
        <form onSubmit={submit}>
          <ErrorNotice message={error} />
          <label>
            Initial password
            <input
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
            />
          </label>
          <label>
            New password
            <input
              name="newPassword"
              type="password"
              autoComplete="new-password"
              minLength={12}
              required
              placeholder="At least 12 characters"
            />
          </label>
          <label>
            Confirm new password
            <input
              name="confirm"
              type="password"
              autoComplete="new-password"
              minLength={12}
              required
            />
          </label>
          <button className="button primary full" disabled={busy}>
            {busy ? <Spinner label="Saving…" /> : "Set password and continue"}
          </button>
        </form>
      </div>
    </div>
  );
}

export function ProjectsApp({
  session,
  setSession,
  logout,
}: {
  session: SessionData;
  setSession: (value: SessionData) => void;
  logout: () => void;
}) {
  const [projectId, setProjectId] = useState(
    () =>
      session.projects.find((value) => value.id === remembered("project"))?.id ||
      session.projects[0]?.id ||
      "",
  );
  const [data, setData] = useState<ProjectData | null>(null);
  const [view, setView] = useState<View>("board");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] = useState<{
    projectId: string; generation: number; query: string; queryGeneration: number; ticketIds: Set<string>;
  } | null>(null);
  const [searchError, setSearchError] = useState("");
  const activeSearch = useRef({ query, generation: 0 });
  if (activeSearch.current.query !== query) {
    activeSearch.current = { query, generation: activeSearch.current.generation + 1 };
  }
  const [priority, setPriority] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  function setSidebarCompact(collapsed: boolean) {
    setSidebarCollapsed(collapsed);
    saveSidebarCollapsed(collapsed);
  }
  const [dialog, setDialog] = useState<
    "project" | "ticket" | "add" | null
  >(null);
  const [ticketExpanded, setTicketExpanded] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState<string | null>(null);
  const [selectedBacklog, setSelectedBacklog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [ticketImages, setTicketImages] = useState<ImageDraft[]>([]);
  const [readingImages, setReadingImages] = useState(false);
  const activeProject = useRef({ id: projectId, generation: 0 });
  if (activeProject.current.id !== projectId) {
    activeProject.current = {
      id: projectId,
      generation: activeProject.current.generation + 1,
    };
  }
  const refreshSequence = useRef(0);
  const appliedRefresh = useRef(0);
  useEffect(() => {
    setSearchError("");
    if (!projectId || !query.trim()) {
      setSearchResult(null);
      return;
    }
    let alive = true;
    const generation = activeProject.current.generation;
    const searchGeneration = activeSearch.current.generation;
    const controller = new AbortController();
    const isCurrent = () => alive && activeSearch.current.query === query &&
      activeSearch.current.generation === searchGeneration &&
      activeProject.current.id === projectId && activeProject.current.generation === generation;
    const timer = window.setTimeout(() => {
      void api<{ ticketIds: string[] }>(
        `/projects/${projectId}/tickets/search?q=${encodeURIComponent(query)}`,
        "GET", undefined, controller.signal,
      ).then((result) => {
        if (isCurrent()) setSearchResult({ projectId, generation, query, queryGeneration: searchGeneration, ticketIds: new Set(result.ticketIds) });
      }).catch((error) => {
        if (isCurrent()) setSearchError(errorMessage(error));
      });
    }, 150);
    return () => { alive = false; controller.abort(); window.clearTimeout(timer); };
  }, [projectId, query, data?.tickets]);
  const projects = session.projects;
  const selectedProject =
    data?.project.id === projectId
      ? data.project
      : projects.find((item) => item.id === projectId);
  const isAdmin = selectedProject?.roles[session.user.id] === "admin";
  const visibleMembers = data?.members.filter((member) => !member.isSystemUser || member.id === session.user.id) ?? [];
  const canCreateProjects = session.user.isSystemUser;
  const canViewAnalytics = !!selectedProject && hasProjectPermission(selectedProject, session.user.id, "analytics");
  const canViewConfig = !!selectedProject && ["peopleRead", "workflowWrite", "generalRead", "sandboxRead"].some((permission) => hasProjectPermission(selectedProject, session.user.id, permission as "peopleRead" | "workflowWrite" | "generalRead" | "sandboxRead"));
  useEffect(() => {
    if (view === "config" && !canViewConfig) setView("board");
  }, [view, canViewConfig]);
  useEffect(() => {
    if (view === "analytics" && !canViewAnalytics) setView("board");
  }, [view, canViewAnalytics]);
  const refreshSession = useCallback(async () => {
    setSession(await api<SessionData>("/auth/me"));
  }, [setSession]);
  const refresh = useCallback(async () => {
    if (!projectId) return;
    const generation = activeProject.current.generation;
    const sequence = ++refreshSequence.current;
    const result = await api<ProjectData>(`/projects/${projectId}`);
    // Polling and action refreshes may finish out of order. A response from an
    // earlier project selection must also stay stale after switching back.
    if (
      activeProject.current.id === projectId &&
      activeProject.current.generation === generation &&
      sequence > appliedRefresh.current
    ) {
      appliedRefresh.current = sequence;
      setData(result);
    }
  }, [projectId]);
  useEffect(() => {
    remembered("project", projectId);
    setData(null);
    setError("");
    setSelectedTicket(null);
    setSelectedBacklog([]);
    setTicketImages([]);
    if (!projectId) return;
    let alive = true;
    setLoading(true);
    void refresh()
      .catch((error) => {
        if (alive) setError(errorMessage(error));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible")
        void refresh().catch((error) => {
          if (alive) setError(errorMessage(error));
        });
    }, 5000);
    return () => {
      alive = false;
      window.clearInterval(interval);
    };
  }, [projectId, refresh]);
  useEffect(() => {
    if (data)
      setSelectedBacklog((current) =>
        current.filter((id) =>
          data.tickets.some(
            (ticket) => ticket.id === id && ticket.status === "backlog",
          ),
        ),
      );
  }, [data]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 5500);
    return () => window.clearTimeout(timer);
  }, [notice]);
  async function run(body: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await body();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCreateProjects) return;
    const values = Object.fromEntries(new FormData(event.currentTarget));
    await run(async () => {
      const created = await api<Project>("/projects", "POST", values);
      await refreshSession();
      setProjectId(created.id);
      setView("config");
      setDialog(null);
    });
  }
  async function createTicket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    await run(async () => {
      const ticket = await api<Ticket>(
        `/projects/${projectId}/tickets`,
        "POST",
        { ...values, status: view === "board" ? "active" : "backlog", attachments: ticketImages.map((image) => image.input) },
      );
      await refresh();
      setDialog(null);
      setTicketExpanded(false);
      setSelectedTicket(ticket.id);
      setTicketImages([]);
      setNotice(`${ticket.number} added to ${view === "board" ? "the board" : "Backlog"}.`);
    });
  }
  async function backlogAction(action: "board" | "close") {
    await run(async () => {
      const count = selectedBacklog.length;
      await api(`/projects/${projectId}/${action === "board" ? "board/tickets" : "backlog/action"}`, "POST", {
        ticketIds: selectedBacklog,
        ...(action === "close" ? { action } : {}),
      });
      setSelectedBacklog([]);
      setDialog(null);
      await refresh();
      setNotice(
        action === "close"
          ? `${count} ticket${count === 1 ? "" : "s"} closed as won’t do and moved to Done.`
          : `${count} ticket${count === 1 ? "" : "s"} added to the board.`,
      );
    });
  }
  const project = data?.project;
  const matchedTicketIds = searchResult?.projectId === projectId &&
    searchResult.generation === activeProject.current.generation && searchResult.query === query &&
    searchResult.queryGeneration === activeSearch.current.generation
      ? searchResult.ticketIds : null;
  const matches = (ticket: Ticket) =>
    (!query.trim() || (matchedTicketIds ? matchedTicketIds.has(ticket.id) : `${ticket.number} ${ticket.title} ${ticket.description}`
      .toLowerCase()
      .includes(query.toLowerCase()))) &&
    (!priority || ticket.priority === priority);
  const tickets = data?.tickets.filter(matches) || [];
  const backlog = tickets.filter((ticket) => ticket.status === "backlog");
  const done = doneTickets(tickets);
  const active = boardTickets(data?.tickets || []).filter(ticket => !priority || ticket.priority === priority);
  const reviewerIds = new Set(project?.steps.flatMap(step => step.approverIds) || []);
  const reviewers = visibleMembers.filter(member => reviewerIds.has(member.id));
  const boardSteps = [...(project?.steps || [])];
  const openCount =
    data?.tickets.filter((ticket) => ticket.status === "active").length || 0;
  const closeDialog = () => {
    if (readingImages || busy) return;
    setDialog(null);
    setTicketExpanded(false);
    setError("");
    setTicketImages([]);
  };
  if (!projects.length && !canCreateProjects)
    return (
      <div className="center-page">
        <div className="theme-floating">
          <ThemeToggle />
        </div>
        <div className="onboarding-card project-onboarding">
          <Brand />
          <span className="eyebrow">PROJECT ACCESS</span>
          <h1>Your team is one step away.</h1>
          <p className="muted">
            Ask a project administrator to add you to a project before getting started.
          </p>
          <button
            className="button text-button"
            onClick={() => void run(async () => {
              await api("/auth/logout", "POST");
              logout();
            })}
            disabled={busy}
          >
            Sign out
          </button>
          <ErrorNotice message={error} />
        </div>
      </div>
    );
  if (!projects.length)
    return (
      <div className="center-page">
        <div className="theme-floating">
          <ThemeToggle />
        </div>
        <div className="onboarding-card project-onboarding">
          <Brand />
          <span className="eyebrow">YOUR TEAM STARTS HERE</span>
          <h1>A place for your next idea.</h1>
          <p className="muted">
            Create a project, connect a repository, and design a workflow for
            your team.
          </p>
          <form onSubmit={createProject}>
            <ErrorNotice message={error} />
            <label>
              Project name
              <input
                name="name"
                placeholder="Customer platform"
                required
                maxLength={100}
                autoFocus
              />
            </label>
            <label>
              Ticket prefix
              <input
                name="key"
                required
                maxLength={10}
                pattern="[A-Za-z][A-Za-z0-9]{1,9}"
                placeholder="PLAT"
                style={{ textTransform: "uppercase" }}
              />
              <small>2–10 letters or numbers, beginning with a letter.</small>
            </label>
            <label>
              Description
              <textarea
                name="description"
                rows={3}
                placeholder="What are we building together?"
              />
            </label>
            <button className="button primary full" disabled={busy}>
              {busy ? (
                <Spinner label="Creating…" />
              ) : (
                <>
                  Create project
                  <ArrowRight size={16} />
                </>
              )}
            </button>
          </form>
          <button
            className="button text-button"
            onClick={() =>
              void run(async () => {
                await api("/auth/logout", "POST");
                logout();
              })
            }
          >
            Sign out
          </button>
        </div>
      </div>
    );
  return (
    <div className={`app-shell ${sidebarCollapsed ? "sidebar-is-collapsed" : ""}`}>
      {mobileNav && (
        <div className="sidebar-shade" onClick={() => setMobileNav(false)} />
      )}
      <aside id="project-navigation" aria-label="Project navigation" className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
        <div className="sidebar-brand">
          <div><Brand /><small className="brand-tagline">Define with your team. Build with your agent.</small></div>
          <button
            className="icon-button mobile-only"
            aria-label="Close navigation"
            onClick={() => setMobileNav(false)}
          >
            <X size={20} />
          </button>
        </div>
        <button
          className="project-switcher-compact icon-button"
          aria-label={`Switch project: ${selectedProject?.name || "Projects"}`}
          title={`Switch project: ${selectedProject?.name || "Projects"}`}
          onClick={() => setSidebarCompact(false)}
        >
          <FolderPlus size={18} />
        </button>
        <div className="project-switcher">
          <label className="selector-label">
            PROJECT
            <select
              aria-label="Project"
              value={projectId}
              onChange={(event) => {
                if (event.target.value === "__create") { setDialog("project"); return; }
                setProjectId(event.target.value);
                setView("board");
              }}
            >
              {!projects.length && <option value="">No projects yet</option>}
              {projects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
              {canCreateProjects && <option value="__create">Create new project</option>}
            </select>
          </label>
        </div>
        <div className="nav-label">PROJECT</div>
        <nav>
          {(
            [
              {
                id: "board",
                label: "Board",
                icon: Bot,
                count: openCount,
              },
              {
                id: "backlog",
                label: "Backlog",
                icon: ListTodo,
                count: data?.tickets.filter(
                  (ticket) => ticket.status === "backlog",
                ).length,
              },
              { id: "done", label: "Done", icon: Archive, count: undefined },
              ...(canViewAnalytics
                ? [{ id: "analytics", label: "Analytics", icon: BarChart3, count: undefined } as const]
                : []),
              ...(canViewConfig
                ? [
                    {
                      id: "config",
                      label: "Config",
                      icon: Settings2,
                      count: undefined,
                    } as const,
                  ]
                : []),
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? "active" : ""}`}
              title={item.label}
              aria-label={item.label}
              aria-current={view === item.id ? "page" : undefined}
              onClick={() => {
                setView(item.id);
                setQuery("");
                setPriority("");
                setMobileNav(false);
              }}
              disabled={!projectId}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
              {item.count !== undefined ? (
                <span className="nav-count">{item.count}</span>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-lower">
          <ThemeToggle />
          <div className="user-row">
            <Avatar name={session.user.name} />
            <div>
              <strong>{session.user.name}</strong>
              <small>{isAdmin ? "Project admin" : "Project member"}</small>
            </div>
            <button
              className="icon-button"
              title="Sign out"
              aria-label="Sign out"
              onClick={() =>
                void run(async () => {
                  await api("/auth/logout", "POST");
                  logout();
                })
              }
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button sidebar-toggle"
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!sidebarCollapsed}
              aria-controls="project-navigation"
              onClick={() => setSidebarCompact(!sidebarCollapsed)}
            >
              {sidebarCollapsed ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}
            </button>
            <button
              className="icon-button mobile-only"
              aria-label="Open navigation"
              onClick={() => setMobileNav(true)}
            >
              <Menu size={20} />
            </button>
            <strong>
              {project?.name ||
                projects.find((item) => item.id === projectId)?.name ||
                "Your projects"}
            </strong>
          </div>
          <div className="topbar-meta">
            {project?.repository && (
              <span>
                <GitBranch size={14} />
                {project.repository}
              </span>
            )}
            <span className="live-label">
              <i />
              Shared project
            </span>
          </div>
        </header>
        <div className="page-content">
          <div className="notification-stack" aria-label="Notifications">
            <ErrorNotice
              message={dialog ? "" : error}
              clear={() => setError("")}
            />
            <ErrorNotice message={dialog ? "" : searchError} clear={() => setSearchError("")} />
            {notice && (
              <div className="toast" role="status">
                <Check size={17} />
                <span>{notice}</span>
                <button
                  className="icon-button"
                  onClick={() => setNotice("")}
                  aria-label="Dismiss notification"
                >
                  <X size={15} />
                </button>
              </div>
            )}
          </div>
          {!projectId ? (
            <EmptyState
              icon={<FolderPlus size={28} />}
              title="Every project starts with an idea."
              action={
                <button
                  className="button primary"
                  onClick={() => setDialog("project")}
                >
                  <Plus size={16} />
                  Create your first project
                </button>
              }
            >
              Create a project, connect a repository, and design a workflow for
              your team.
            </EmptyState>
          ) : loading ? (
            <div className="page-loading">
              <Spinner label="Loading project…" />
            </div>
          ) : !data ? (
            <EmptyState
              icon={<Layers3 size={28} />}
              title="Project unavailable"
              action={
                <button className="button" onClick={() => void run(refresh)}>
                  Retry
                </button>
              }
            >
              The project could not be loaded. Check the message above.
            </EmptyState>
          ) : view === "analytics" && canViewAnalytics ? (
            <Analytics
              key={projectId}
              projectId={projectId}
              onTicketSelect={setSelectedTicket}
              onAccessDenied={() => {
                setView("board");
                setError("Analytics access is no longer available for this project.");
                void refresh().catch((failure) => setError(errorMessage(failure)));
                void refreshSession().catch((failure) => setError(errorMessage(failure)));
              }}
            />
          ) : view === "config" && canViewConfig ? (
            <Config
              key={projectId}
              data={data}
              userId={session.user.id}
              refresh={async () => {
                await refresh();
                await refreshSession();
              }}
              notify={setNotice}
              setError={setError}
            />
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">
                    {view === "board"
                      ? "TURN INTENT INTO IMPACT"
                      : view === "backlog"
                        ? "ROOM FOR WHAT’S NEXT"
                        : "PROGRESS, PRESERVED"}
                  </span>
                  <h1>
                    {view === "board"
                      ? "Agentic Kanban Board"
                      : view === "backlog"
                        ? "Backlog"
                        : "Done archive"}
                    <span className="heading-dot">.</span>
                  </h1>
                  <p>
                    {view === "board"
                      ? "A clear path from the first thought to the final pull request."
                      : view === "backlog"
                        ? "Capture the ideas. Pick the work that matters next."
                        : "Completed work and closed ideas, with their full history."}
                  </p>
                </div>
                <div className="heading-actions">
                  {view !== "done" && (
                    <button
                      className="button primary"
                      onClick={() => setDialog("ticket")}
                    >
                      <Plus size={17} />
                      {view === "board" ? "Create new ticket" : "New ticket"}
                    </button>
                  )}
                  {view === "board" && (
                    <button
                      className="button"
                      onClick={() => setDialog("add")}
                    >
                      <Plus size={16} />
                      Add from Backlog
                    </button>
                  )}
                </div>
              </div>
              {view === "board" && (
                <div className="board-members">
                  <div className="avatar-stack">{reviewers.slice(0, 4).map(member => <Avatar key={member.id} name={member.name} small />)}</div>
                  <span>{reviewers.length} {reviewers.length === 1 ? "member" : "members"}</span>
                </div>
              )}
              <div className="filter-bar">
                <label className="search">
                  <Search size={17} />
                  <input
                    aria-label="Search tickets"
                    maxLength={200}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search tickets…"
                  />
                  <kbd>⌕</kbd>
                </label>
                <select
                  aria-label="Filter by priority"
                  value={priority}
                  onChange={(event) => setPriority(event.target.value)}
                >
                  <option value="">All priorities</option>
                  {["urgent", "high", "medium", "low"].map((value) => (
                    <option key={value} value={value}>
                      {value[0].toUpperCase() + value.slice(1)}
                    </option>
                  ))}
                </select>
                <span className="filter-count">
                  {view === "board"
                    ? active.length
                    : view === "backlog"
                      ? backlog.length
                      : done.length}{" "}
                  tickets
                </span>
              </div>
              {view === "backlog" && selectedBacklog.length > 0 && (
                <div className="backlog-actions">
                  <strong>{selectedBacklog.length} selected</strong>
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() => void backlogAction("board")}
                  >
                    <Plus size={15} />
                    Add to Board
                  </button>
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => void backlogAction("close")}
                  >
                    <Archive size={15} />
                    Close — won’t do
                  </button>
                  <button
                    className="button text-button"
                    disabled={busy}
                    onClick={() => setSelectedBacklog([])}
                  >
                    Clear selection
                  </button>
                </div>
              )}
              {view === "board" ? (
                <div className="board">
                  {boardSteps.map((column, index) => {
                    const cards = active.filter(
                      (ticket) => ticket.stepId === column.id,
                    );
                    const historical = !data.project.steps.some(
                      (step) => step.id === column.id,
                    );
                    return (
                      <section
                        className={`board-column column-${column.kind}`}
                        key={column.id}
                      >
                        <header className="column-heading">
                          <span className="column-status">
                            {column.kind === "implement" ? (
                              <Code2 size={15} />
                            ) : (
                              <CircleDot size={14} />
                            )}
                          </span>
                          <h2
                            title={
                              historical
                                ? "Completed tickets from a removed workflow step"
                                : undefined
                            }
                          >
                            {column.name}
                            {historical && " · Completed"}
                          </h2>
                          <span className="column-count">{cards.length}</span>
                          <span className="column-index">0{index + 1}</span>
                        </header>
                        <div className="column-cards">
                          {cards.map((ticket) => (
                            <TicketCard
                              key={ticket.id}
                              ticket={ticket}
                              data={data}
                              highlighted={!!query.trim() && matches(ticket)}
                              open={() => setSelectedTicket(ticket.id)}
                            />
                          ))}
                          {!cards.length && (
                            <div className="empty-column">
                              <span className="empty-column-mark">+</span>
                              <span>
                                {column.kind === "parking"
                                  ? "Ready for your next idea"
                                  : "A little space for progress"}
                              </span>
                            </div>
                          )}
                        </div>
                      </section>
                    );
                  })}
                </div>
              ) : (
                <div className="ticket-table">
                  {!(view === "backlog" ? backlog : done).length ? (
                    <EmptyState
                      icon={
                        view === "backlog" ? (
                          <ListTodo size={27} />
                        ) : (
                          <Archive size={27} />
                        )
                      }
                      title={
                        query || priority
                          ? "No matching tickets"
                          : view === "backlog"
                            ? "Make room for a new idea."
                            : "Good work will live here."
                      }
                      action={
                        view === "backlog" && !query && !priority ? (
                          <button
                            className="button"
                            onClick={() => setDialog("ticket")}
                          >
                            <Plus size={16} />
                            Add a ticket
                          </button>
                        ) : undefined
                      }
                    >
                      {query || priority
                        ? "Try a different search or adjust your filters."
                        : view === "backlog"
                          ? "Capture a task, a fix, or a feature to get started."
                          : "Tickets marked Done or closed from Backlog appear here immediately."}
                    </EmptyState>
                  ) : (
                    <>
                      <div className="table-heading">
                        <span>
                          {view === "backlog"
                            ? `${selectedBacklog.length ? `${selectedBacklog.length} selected` : "Select tickets to add to the Board or close"}`
                            : "Closed tickets"}
                        </span>
                        <span>Priority</span>
                      </div>
                      {(view === "backlog" ? backlog : done).map((ticket) => (
                        <div className="ticket-row" key={ticket.id}>
                          {view === "backlog" && (
                            <input
                              className="row-checkbox"
                              type="checkbox"
                              aria-label={`Select ${ticket.number}`}
                              disabled={busy}
                              checked={selectedBacklog.includes(ticket.id)}
                              onChange={(event) =>
                                setSelectedBacklog((current) =>
                                  event.target.checked
                                    ? [...current, ticket.id]
                                    : current.filter((id) => id !== ticket.id),
                                )
                              }
                            />
                          )}
                          <button
                            className="ticket-row-main"
                            onClick={() => setSelectedTicket(ticket.id)}
                          >
                            <span className="ticket-number">
                              {ticket.number}
                            </span>
                            <strong>{ticket.title}</strong>
                            {view === "done" && (
                              <small>
                                Closed{" "}
                                {ticket.closedAt
                                  ? dateLabel(ticket.closedAt)
                                  : ""}
                              </small>
                            )}
                          </button>
                          {ticket.pullRequests.map((pr) => (
                            <a
                              className="pr-link"
                              key={pr.runId}
                              href={pr.url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <GitPullRequest size={14} />#{pr.number}
                            </a>
                          ))}
                          <Priority value={ticket.priority} />
                          <button
                            className="icon-button"
                            aria-label={`Open ${ticket.number}`}
                            onClick={() => setSelectedTicket(ticket.id)}
                          >
                            <ChevronRight size={17} />
                          </button>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </>
          )}
          <footer className="project-footer"><span><img src="/kangentix-logo.svg" alt="" width="18" height="18" />Every step, decision, and conversation stays with your ticket.</span><a href="https://github.com/mrSingh007/Kangentix" target="_blank" rel="noreferrer">© Kangentix</a></footer>
        </div>
      </main>
      {dialog && (dialog !== "project" || canCreateProjects) && (
        <Modal
          title={
            dialog === "project"
              ? "Create a project"
              : dialog === "ticket"
                ? "A new idea starts here"
                : "Add from Backlog"
          }
          fullScreen={dialog === "ticket" && ticketExpanded}
          headerAside={dialog === "ticket" ? <button className="icon-button" aria-label={ticketExpanded ? "Collapse" : "Expand"} title={ticketExpanded ? "Collapse" : "Expand"} onClick={() => setTicketExpanded(value => !value)}>{ticketExpanded ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button> : undefined}
          close={closeDialog}
        >
          <form
            className="modal-form"
            onSubmit={
              dialog === "project"
                ? createProject
                : dialog === "ticket"
                  ? createTicket
                  : (event) => { event.preventDefault(); void backlogAction("board"); }
            }
          >
            <ErrorNotice message={error} />
            {dialog === "project" ? (
              <>
                <label>
                  Project name
                  <input
                    name="name"
                    required
                    maxLength={100}
                    placeholder="Customer platform"
                  />
                </label>
                <label>
                  Ticket prefix
                  <input
                    name="key"
                    required
                    maxLength={10}
                    pattern="[A-Za-z][A-Za-z0-9]{1,9}"
                    placeholder="PLAT"
                    style={{ textTransform: "uppercase" }}
                  />
                  <small>
                    2–10 letters or numbers, beginning with a letter.
                  </small>
                </label>
                <label>
                  Description
                  <textarea
                    name="description"
                    rows={3}
                    placeholder="What are we building together?"
                  />
                </label>
              </>
            ) : dialog === "ticket" ? (
              <>
                <label>
                  Title
                  <input
                    name="title"
                    required
                    maxLength={240}
                    placeholder="What would you like to build?"
                  />
                </label>
                <label>
                  Description
                  <textarea
                    name="description"
                    required
                    rows={5}
                    placeholder="Add context, desired behavior, and anything the team should know. Markdown is supported."
                  />
                </label>
                <TicketImages
                  images={ticketImages}
                  onChange={setTicketImages}
                  disabled={busy}
                  onBusy={setReadingImages}
                />
                <label>
                  Priority
                  <select name="priority" defaultValue="medium">
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="urgent">Urgent</option>
                  </select>
                </label>
                <p className="form-hint">
                  {view === "board" ? "Your ticket enters the first workflow step on the Board." : "Your ticket starts in Backlog. Add it to the Board when it’s ready."}
                </p>
              </>
            ) : (
              <>
                {!data?.tickets.some(ticket => ticket.status === "backlog") && <p className="muted">No backlog tickets are available. Create a new ticket to add work to the Board.</p>}
                <div className="backlog-picker">
                  {data?.tickets
                    .filter((ticket) => ticket.status === "backlog")
                    .map((ticket) => (
                      <label className="check-row" key={ticket.id}>
                        <input
                          type="checkbox"
                          disabled={busy}
                          checked={selectedBacklog.includes(ticket.id)}
                          onChange={(event) =>
                            setSelectedBacklog((current) =>
                              event.target.checked
                                ? [...current, ticket.id]
                                : current.filter((id) => id !== ticket.id),
                            )
                          }
                        />
                        <span>
                          <small>{ticket.number}</small>
                          {ticket.title}
                        </span>
                      </label>
                    ))}
                </div>
              </>
            )}
            <div className="modal-actions">
              <button className="button" type="button" onClick={closeDialog}>
                Cancel
              </button>
              <button
                className="button primary"
                disabled={busy || readingImages || (dialog === "add" && !selectedBacklog.length)}
              >
                {busy ? (
                  <Spinner label="Saving…" />
                ) : dialog === "project" ? (
                  "Create project"
                ) : dialog === "ticket" ? (
                  "Create ticket"
                ) : (
                  "Add to Board"
                )}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {selectedTicket &&
        data &&
        data.tickets.find((ticket) => ticket.id === selectedTicket) && (
          <TicketDetail
            key={`${data.project.id}:${selectedTicket}`}
            ticket={
              data.tickets.find((ticket) => ticket.id === selectedTicket)!
            }
            data={data}
            user={session.user}
            refresh={refresh}
            close={() => setSelectedTicket(null)}
            notify={setNotice}
          />
        )}
    </div>
  );
}

export function Priority({ value }: { value: Ticket["priority"] }) {
  const Icon =
    value === "urgent"
      ? Zap
      : value === "high"
        ? ArrowUp
        : value === "low"
          ? ArrowDown
          : Circle;
  return (
    <span className={`priority priority-${value}`} title={`${value} priority`}>
      <Icon size={13} />
      <span>{value}</span>
    </span>
  );
}
function TicketCard({
  ticket,
  data,
  open,
  highlighted = false,
}: {
  highlighted?: boolean;
  ticket: Ticket;
  data: ProjectData;
  open: () => void;
}) {
  const step = (ticket.workflowSnapshot ?? data.project.steps).find(
    (item) => item.id === ticket.stepId,
  );
  const run = data.runs
    .filter((item) => item.ticketId === ticket.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const approvals = new Set(
    data.approvals
      .filter(
        (item) =>
          item.ticketId === ticket.id &&
          item.stepId === ticket.stepId &&
          (step?.approverIds.includes(item.userId) || (item.anonymous && !!step?.hiddenApproverCount)),
      )
      .map((item) => item.userId),
  ).size;
  const required = step ? requiredApprovalCount(step) : 0;
  return (
    <article
      className={`ticket-card ${ticket.status === "closed" ? "ticket-card-done" : ""} ${highlighted ? "ticket-card-match" : ""}`}
    >
      <button className="ticket-card-open" onClick={open}>
        <div className="ticket-card-top">
          <span className="ticket-number">{ticket.number}</span>
          <Priority value={ticket.priority} />
        </div>
        <h3>{ticket.title}</h3>
        {ticket.description && (
          <p>{ticket.description.replace(/[#*_`]/g, "").slice(0, 115)}</p>
        )}
        <div className="ticket-card-status">
          {ticket.status === "closed" ? (
            <span className="run-pill completed">
              <Check size={13} />
              Done
            </span>
          ) : run && (run.status === "running" || run.status === "pending") ? (
            <span className="run-pill running">
              <span className="pulse-dot" />
              {run.status === "pending" ? "Queued" : "Agent working"}
            </span>
          ) : run?.status === "failed" ? (
            <span className="run-pill failed">{run.cleanupStatus === "pending" ? "Run failed · cleanup pending" : "Run failed · open to retry"}</span>
          ) : run?.cleanupStatus === "pending" ? (
            <span className="quiet-label">Sandbox cleanup pending</span>
          ) : (
            <span className="quiet-label">
              {step && required > approvals
                ? "Awaiting approval"
                : step?.kind === "parking"
                  ? "Ready to begin"
                  : "Ready for the next step"}
            </span>
          )}
        </div>
        <div className="ticket-card-bottom">
          <span
            className={
              ticket.status === "active" && step && required > 0
                ? `approval-pill ${approvals >= required ? "approved" : ""}`
                : "quiet-label"
            }
          >
            <ShieldCheck size={12} />
            {ticket.status === "closed"
              ? "Completed · read-only"
              : step && required > 0
                ? `${approvals}/${required} approvals`
                : "No approvals required"}
          </span>
          <span className="card-arrow">
            <ArrowRight size={15} />
          </span>
        </div>
      </button>
      {ticket.pullRequests.map((pr) => (
        <a
          className="card-pr"
          key={pr.runId}
          href={pr.url}
          target="_blank"
          rel="noreferrer"
        >
          <GitPullRequest size={13} />
          Pull request #{pr.number}
          <ArrowRight size={12} />
        </a>
      ))}
    </article>
  );
}
