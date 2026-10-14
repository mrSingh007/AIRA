import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  Clock3,
  Code2,
  FileText,
  GitPullRequest,
  History,
  LockKeyhole,
  Maximize2,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Save,
  Send,
  ShieldCheck,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import type {
  Artifact,
  ProjectData,
  Run,
  Thread,
  Ticket,
  TicketDetailData,
  User,
} from "../shared/types";
import { api, dateLabel, errorMessage } from "./api";
import { Avatar, EmptyState, ErrorNotice, Modal, Spinner } from "./ui";
import {
  TicketImages,
  ticketImageDrafts,
  type ImageDraft,
} from "./TicketImages";
import { requiredApprovalCount, implementationReady } from "../shared/workflow";
import { pollRunLogs } from "./run-logs";
import { mergeOlderHistory, mergeLatestHistory } from "./ticket-history";

export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          img: ({ src, alt }) => {
            if (typeof src !== "string" || !src) return <span>{alt}</span>;
            let url: URL;
            try {
              url = new URL(src, window.location.origin);
            } catch {
              return <span>{alt}</span>;
            }
            if (!["http:", "https:"].includes(url.protocol))
              return <span>{alt}</span>;
            if (
              url.origin === window.location.origin &&
              /^\/api\/tickets\/[^/]+\/attachments\/[^/]+$/.test(url.pathname)
            )
              return <img src={url.href} alt={alt || "Ticket image"} />;
            // Untrusted Markdown must not make automatic requests to tracking
            // endpoints or arbitrary same-origin routes when a ticket opens.
            return (
              <a href={url.href} target="_blank" rel="noopener noreferrer">
                {alt || "Open image"}
              </a>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

function RunLogPanel({ run }: { run: Run }) {
  const [tail, setTail] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const version = useRef<number | null>(null);
  useEffect(() => pollRunLogs({
    run,
    version: version.current,
    receive: (result) => {
        version.current = result.version;
        if (!result.unchanged) setTail(result.tail || "");
        setError("");
        setLoading(false);
    },
    fail: (error) => {
        setError(errorMessage(error));
        setLoading(false);
    },
  }), [run.id, run.status, run.cleanupStatus, run.logSealed]);
  return <div className="run-log-body">
    {run.error && <ErrorNotice message={run.error} />}
    <ErrorNotice message={error} />
    {run.cleanupStatus === "pending" && <p className="muted">Sandbox cleanup is pending. This run still reserves project capacity.</p>}
    {run.status === "pending" && <p className="muted">{run.eligibleAt && new Date(run.eligibleAt).getTime() > Date.now() ? "Waiting to retry after provider capacity or throttling." : "Queued — waiting for project or sandbox preparation capacity."}</p>}
    {loading ? <Spinner label="Loading logs…" /> : <pre className="run-logs">{tail || "No log output recorded."}</pre>}
    {run.finishedAt && <small className="muted">Finished {dateLabel(run.finishedAt)}</small>}
  </div>;
}

type TicketDetailProps = {
  ticket: Ticket;
  data: ProjectData;
  user: User;
  refresh: () => Promise<void>;
  close: () => void;
  notify: (message: string) => void;
};

export function TicketDetail(props: TicketDetailProps) {
  const { ticket, data, refresh, close } = props;
  const [detail, setDetail] = useState<TicketDetailData | null>(null);
  const [error, setError] = useState("");
  const [paging, setPaging] = useState("");
  const mounted = useRef(true);
  const sequence = useRef(0);
  const loadedHistory = useRef({ runs: false, audit: false });
  const load = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const result = await api<TicketDetailData>(`/tickets/${ticket.id}/detail`);
      if (!mounted.current || request !== sequence.current) return;
      setDetail((previous) => {
        if (!previous) return result;
        const runs = mergeLatestHistory({ previous: previous.runs, latest: result.runs,
          previousCursor: previous.nextRunsCursor, latestCursor: result.nextRunsCursor,
          pageOldest: result.runsPageOldest, loadedHistory: loadedHistory.current.runs });
        const audit = mergeLatestHistory({ previous: previous.audit, latest: result.audit,
          previousCursor: previous.nextAuditCursor, latestCursor: result.nextAuditCursor,
          pageOldest: result.auditPageOldest, loadedHistory: loadedHistory.current.audit });
        return { ...result, runs: runs.records, audit: audit.records,
          nextRunsCursor: runs.cursor, nextAuditCursor: audit.cursor };
      });
      setError("");
    } catch (error) {
      if (!mounted.current || request !== sequence.current) return;
      setError(errorMessage(error));
      throw error;
    }
  }, [ticket.id]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; sequence.current++; };
  }, []);
  useEffect(() => {
    void load().catch(() => {});
  }, [data, load]);
  async function loadMore(kind: "runs" | "audit") {
    const cursor = kind === "runs" ? detail?.nextRunsCursor : detail?.nextAuditCursor;
    if (!cursor || paging) return;
    setPaging(kind);
    try {
      const page = await api<TicketDetailData>(`/tickets/${ticket.id}/detail?${kind}Before=${encodeURIComponent(cursor)}`);
      if (!mounted.current) return;
      loadedHistory.current[kind] = true;
      setDetail((previous) => {
        if (!previous) return previous;
        if (kind === "runs") {
          const merged = mergeOlderHistory({ previous: previous.runs, page: page.runs,
            previousCursor: previous.nextRunsCursor, requestedCursor: cursor, pageCursor: page.nextRunsCursor });
          return { ...previous, runs: merged.records, nextRunsCursor: merged.cursor };
        }
        const merged = mergeOlderHistory({ previous: previous.audit, page: page.audit,
          previousCursor: previous.nextAuditCursor, requestedCursor: cursor, pageCursor: page.nextAuditCursor });
        return { ...previous, audit: merged.records, nextAuditCursor: merged.cursor };
      });
      setError("");
    } catch (error) {
      if (mounted.current) setError(errorMessage(error));
    } finally {
      if (mounted.current) setPaging("");
    }
  }
  if (!detail) return <Modal title={ticket.number} close={close} wide>
    {error ? <><ErrorNotice message={error} /><button className="button" onClick={() => void load().catch(() => {})}>Try again</button></> : <Spinner label="Loading ticket…" />}
  </Modal>;
  return <TicketDetailView {...props} ticket={detail.ticket}
    data={{ ...data, artifacts: detail.artifacts, approvals: detail.approvals, threads: detail.threads, messages: detail.messages, runs: detail.runs, audit: detail.audit }}
    refresh={async () => { await refresh(); await load(); }}
    history={{ nextRuns: !!detail.nextRunsCursor, nextAudit: !!detail.nextAuditCursor, paging, loadMore, error }}
  />;
}

function TicketDetailView({
  ticket,
  data,
  user,
  refresh,
  close,
  notify,
  history,
}: {
  ticket: Ticket;
  data: ProjectData;
  user: User;
  refresh: () => Promise<void>;
  close: () => void;
  notify: (message: string) => void;
  history: { nextRuns: boolean; nextAudit: boolean; paging: string; loadMore: (kind: "runs" | "audit") => Promise<void>; error: string };
}) {
  const isBacklog = ticket.status === "backlog";
  const isDone = ticket.status === "closed";
  const workflowSteps =
    ticket.workflowSnapshot ?? (isDone ? [] : data.project.steps);
  const documentSteps = workflowSteps.filter(
    (step) => step.kind === "definition",
  );
  const currentStep = workflowSteps.find((step) => step.id === ticket.stepId);
  const isLastStep =
    !!currentStep && workflowSteps.at(-1)?.id === currentStep.id;
  const isAgentStep =
    currentStep?.kind === "definition" || currentStep?.kind === "implement";
  const completesTicket = isLastStep;
  const pullRequests = ticket.pullRequests;
  const [selectedTab, setTab] = useState(
    !isBacklog && currentStep?.kind === "definition"
      ? currentStep.id
      : "overview",
  );
  const tab =
    isBacklog && selectedTab !== "activity" ? "overview" : selectedTab;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [editingDetails, setEditingDetails] = useState(false);
  const [title, setTitle] = useState(ticket.title);
  const [description, setDescription] = useState(ticket.description);
  const [priority, setPriority] = useState(ticket.priority);
  const [images, setImages] = useState<ImageDraft[]>(() =>
    ticketImageDrafts(ticket),
  );
  const [readingImages, setReadingImages] = useState(false);
  const [artifactDraft, setArtifactDraft] = useState<{
    stepId: string;
    content: string;
    version?: number;
  } | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [showLogs, setShowLogs] = useState<string | null>(null);
  const [expandedPane, setExpandedPane] = useState<"ticket" | "chat" | null>(
    null,
  );
  const ticketExpandButton = useRef<HTMLButtonElement>(null);
  const chatExpandButton = useRef<HTMLButtonElement>(null);
  const selectedStep = documentSteps.find((step) => step.id === tab);
  const hasChat = selectedStep?.kind === "definition";
  const fullScreenPane =
    expandedPane === "chat" && !hasChat ? null : expandedPane;
  useEffect(() => {
    if (!hasChat && expandedPane === "chat") setExpandedPane(null);
  }, [hasChat, expandedPane]);
  function restorePanes() {
    const trigger =
      expandedPane === "chat" ? chatExpandButton : ticketExpandButton;
    setExpandedPane(null);
    requestAnimationFrame(() => trigger.current?.focus());
  }
  const artifact = data.artifacts.find(
    (item) => item.ticketId === ticket.id && item.stepId === tab,
  );
  const ticketRuns = data.runs
    .filter((run) => run.ticketId === ticket.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const activeRun = ticketRuns.find(
    (run) => run.status === "pending" || run.status === "running",
  );
  const latestRun = ticketRuns[0];
  const currentApprovals = data.approvals.filter(
    (approval) =>
      approval.ticketId === ticket.id &&
      approval.stepId === ticket.stepId &&
      (currentStep?.approverIds.includes(approval.userId) ||
        (approval.anonymous && !!currentStep?.hiddenApproverCount)),
  );
  const ownApproval = currentApprovals.find(
    (approval) => approval.userId === user.id,
  );
  const eligible = currentStep?.approverIds.includes(user.id);
  const requiredApprovals = currentStep
    ? requiredApprovalCount(currentStep)
    : 0;
  const approvalsMet =
    new Set(currentApprovals.map((approval) => approval.userId)).size >=
    requiredApprovals;
  const implementationComplete =
    !!currentStep && implementationReady(ticket, currentStep, data.runs);
  const needsImplementation =
    currentStep?.kind === "implement" && !implementationComplete;
  const canEditDocument =
    ticket.status === "active" &&
    selectedStep?.kind === "definition" &&
    selectedStep.id === ticket.stepId;
  const canChat = canEditDocument && !activeRun;
  const threads = data.threads
    .filter((thread) => thread.ticketId === ticket.id && thread.stepId === tab)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const selectedThread = threads.find((thread) => thread.id === threadId);
  const messages = data.messages
    .filter((message) => message.threadId === selectedThread?.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const currentArtifact = data.artifacts.find(
    (item) => item.ticketId === ticket.id && item.stepId === ticket.stepId,
  );
  const generationFailed =
    currentStep?.kind === "definition" &&
    ticketRuns.find(
      (run) => run.stepId === currentStep.id && run.kind === "definition",
    )?.status === "failed";
  const needsArtifact =
    currentStep?.kind === "definition" && !currentArtifact?.content.trim();
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
  function changeTab(value: string) {
    setTab(value);
    setThreadId(null);
    setPrompt("");
    setError("");
  }
  async function saveDetails(event: FormEvent) {
    event.preventDefault();
    if (!isBacklog) return;
    await action("details", async () => {
      await api(`/tickets/${ticket.id}`, "PATCH", {
        title,
        priority,
        description,
        attachments: images.map((image) => image.input),
      });
      setEditingDetails(false);
      notify("Ticket details saved.");
    });
  }
  async function saveArtifact() {
    if (!artifactDraft) return;
    await action("artifact", async () => {
      await api<Artifact>(
        `/tickets/${ticket.id}/artifacts/${artifactDraft.stepId}`,
        "PUT",
        { content: artifactDraft.content, version: artifactDraft.version },
      );
      setArtifactDraft(null);
      notify("Document saved. Previous approvals have been cleared.");
    });
  }
  async function sendPrompt(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim()) return;
    const content = prompt.trim();
    await action("chat", async () => {
      if (selectedThread)
        await api(`/threads/${selectedThread.id}/messages`, "POST", {
          content,
        });
      else {
        const thread = await api<Thread>(
          `/tickets/${ticket.id}/threads`,
          "POST",
          { stepId: tab, content },
        );
        setThreadId(thread.id);
      }
      setPrompt("");
    });
  }
  const runAgent = () =>
    action("run", async () => {
      await api(`/tickets/${ticket.id}/runs`, "POST", {
        stepId: ticket.stepId,
      });
      notify("Agent run queued. Progress appears in Execution.");
    });
  const selectedArtifactDraft =
    artifactDraft?.stepId === tab ? artifactDraft : null;
  return (
    <Modal
      title={ticket.number}
      close={fullScreenPane ? restorePanes : close}
      wide
      fullScreen={!!fullScreenPane}
      showCloseButton={!fullScreenPane}
      closeLabel={
        fullScreenPane ? `Close full-screen ${fullScreenPane}` : "Close dialog"
      }
      headerAside={
        <div className="ticket-header-metadata">
          <span>
            <span className="metadata-label">Priority</span>
            <span className={`priority-text priority-${ticket.priority}`}>
              {ticket.priority}
            </span>
          </span>
          {!isBacklog && (
            <>
              <span
                title={currentApprovals
                  .filter((approval) => !approval.anonymous)
                  .map(
                    (approval) =>
                      data.members.find(
                        (member) => member.id === approval.userId,
                      )?.name || "Former member",
                  )
                  .join(", ")}
              >
                <ShieldCheck size={13} />
                <span className="metadata-label">Approvals</span>
                <span>
                  {ticket.status === "active" && currentStep
                    ? requiredApprovals
                      ? `${currentApprovals.length} / ${requiredApprovals}`
                      : "Not required"
                    : "Completed"}
                </span>
              </span>
              <span>
                <span className="metadata-label">Sprint</span>
                <span>
                  {data.sprints.find((sprint) => sprint.id === ticket.sprintId)
                    ?.name || "Not scheduled"}
                </span>
              </span>
            </>
          )}
          <span className="ticket-meta-line">
            <span className="muted">{data.project.name}</span>
            <span className="muted">Created {dateLabel(ticket.createdAt)}</span>
          </span>
        </div>
      }
    >
      <div className="ticket-dialog">
        <ErrorNotice message={error} clear={() => setError("")} />
        <div
          className={`ticket-layout ${hasChat ? "with-chat" : ""} ${fullScreenPane ? `expanded-${fullScreenPane}` : ""}`}
        >
          <section
            className="ticket-reading-pane"
            aria-label="Ticket details"
            hidden={fullScreenPane === "chat"}
          >
            <div className="ticket-detail-heading">
              <h1>{ticket.title}</h1>
              <div className="ticket-heading-actions">
                {isBacklog && (
                  <button
                    className="button subtle"
                    onClick={() => {
                      setTitle(ticket.title);
                      setDescription(ticket.description);
                      setPriority(ticket.priority);
                      setImages(ticketImageDrafts(ticket));
                      setEditingDetails(true);
                      setTab("overview");
                    }}
                    disabled={!!busy || readingImages}
                  >
                    <Pencil size={14} />
                    Edit ticket
                  </button>
                )}
                <button
                  ref={ticketExpandButton}
                  className="icon-button"
                  aria-label={
                    fullScreenPane === "ticket"
                      ? "Restore ticket panel"
                      : "Expand ticket to full screen"
                  }
                  title={
                    fullScreenPane === "ticket"
                      ? "Restore ticket panel"
                      : "Expand ticket to full screen"
                  }
                  aria-expanded={fullScreenPane === "ticket"}
                  onClick={() =>
                    fullScreenPane === "ticket"
                      ? restorePanes()
                      : setExpandedPane("ticket")
                  }
                >
                  {fullScreenPane === "ticket" ? (
                    <X size={17} />
                  ) : (
                    <Maximize2 size={17} />
                  )}
                </button>
              </div>
            </div>
            {!isBacklog &&
              pullRequests.map((pr) => (
                <a
                  className="pull-request-banner"
                  key={pr.runId}
                  href={pr.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="pr-banner-icon">
                    <GitPullRequest size={23} />
                  </span>
                  <span>
                    <strong>Pull request #{pr.number}</strong>
                    <small>
                      {workflowSteps.find((step) => step.id === pr.stepId)
                        ?.name || "Ticket changes"}{" "}
                      · Open on GitHub
                    </small>
                  </span>
                  <ArrowRight size={18} />
                </a>
              ))}
            {isDone && (
              <div className="read-only-label">
                <LockKeyhole size={14} />
                This ticket is done and cannot be edited.
                {ticket.sprintId &&
                data.sprints.some(
                  (sprint) => sprint.id === ticket.sprintId && !sprint.endedAt,
                )
                  ? " It will move to the Done archive when the next sprint starts."
                  : ""}
              </div>
            )}
            {!isBacklog && activeRun && (
              <div className="run-banner" role="status">
                <Sparkles size={17} className="pulse" />
                <div>
                  <strong>
                    {activeRun.status === "pending"
                      ? "Your agent is queued"
                      : "Your agent is working"}
                  </strong>
                  <span>
                    {
                      workflowSteps.find((step) => step.id === activeRun.stepId)
                        ?.name
                    }{" "}
                    ·{" "}
                    {activeRun.kind === "chat"
                      ? "Replying to the conversation"
                      : activeRun.kind === "implement"
                        ? "Preparing repository changes"
                        : "Preparing your document"}
                  </span>
                </div>
                <button
                  className="button text-button"
                  onClick={() => {
                    setTab("execution");
                    setShowLogs(activeRun.id);
                  }}
                >
                  View progress
                  <ArrowRight size={14} />
                </button>
              </div>
            )}
            {!isBacklog && !activeRun && latestRun?.status === "failed" && (
              <div className="failed-banner">
                <span>
                  <strong>The last agent run failed.</strong>
                </span>
                <button
                  className="button small-button"
                  onClick={() => {
                    setTab("execution");
                    setShowLogs(latestRun.id);
                  }}
                >
                  View details
                </button>
              </div>
            )}
            <div
              className="ticket-tabs"
              role="tablist"
              aria-label="Ticket sections"
            >
              <button
                role="tab"
                aria-selected={tab === "overview"}
                className={tab === "overview" ? "active" : ""}
                onClick={() => changeTab("overview")}
              >
                <FileText size={14} />
                Overview
              </button>
              {!isBacklog &&
                documentSteps.map((step) => (
                  <button
                    key={step.id}
                    role="tab"
                    aria-selected={tab === step.id}
                    className={tab === step.id ? "active" : ""}
                    onClick={() => changeTab(step.id)}
                  >
                    {data.artifacts.some(
                      (item) =>
                        item.ticketId === ticket.id && item.stepId === step.id,
                    ) ? (
                      <FileText size={14} />
                    ) : (
                      <span className="tab-step-dot" />
                    )}
                    {step.name}
                    {step.id === ticket.stepId &&
                      (ticket.status === "active" ||
                        ticket.status === "closed") && (
                        <span className="current-tab-dot" />
                      )}
                  </button>
                ))}
              {!isBacklog && (
                <button
                  role="tab"
                  aria-selected={tab === "execution"}
                  className={tab === "execution" ? "active" : ""}
                  onClick={() => changeTab("execution")}
                >
                  <Terminal size={14} />
                  Execution
                  <span className="small-count">{ticketRuns.length}</span>
                </button>
              )}
              <button
                role="tab"
                aria-selected={tab === "activity"}
                className={tab === "activity" ? "active" : ""}
                onClick={() => changeTab("activity")}
              >
                <History size={14} />
                Activity
              </button>
            </div>
            <div className="ticket-content">
              <div className="ticket-main-panel">
                {tab === "overview" ? (
                  editingDetails && isBacklog ? (
                    <form className="details-form" onSubmit={saveDetails}>
                      <h3>Edit ticket</h3>
                      <label>
                        Title
                        <input
                          value={title}
                          onChange={(event) => setTitle(event.target.value)}
                          required
                          maxLength={240}
                        />
                      </label>
                      <label>
                        Description
                        <textarea
                          value={description}
                          onChange={(event) =>
                            setDescription(event.target.value)
                          }
                          rows={9}
                          placeholder="Add context and acceptance criteria. Markdown is supported."
                        />
                      </label>
                      <TicketImages
                        images={images}
                        onChange={setImages}
                        disabled={!!busy}
                        onBusy={setReadingImages}
                      />
                      <label>
                        Priority
                        <select
                          value={priority}
                          onChange={(event) =>
                            setPriority(
                              event.target.value as Ticket["priority"],
                            )
                          }
                        >
                          {["low", "medium", "high", "urgent"].map((value) => (
                            <option key={value} value={value}>
                              {value[0].toUpperCase() + value.slice(1)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="form-actions">
                        <button
                          type="button"
                          className="button"
                          disabled={!!busy || readingImages}
                          onClick={() => setEditingDetails(false)}
                        >
                          Cancel
                        </button>
                        <button
                          className="button primary"
                          disabled={!!busy || readingImages}
                        >
                          {busy === "details" ? (
                            <Spinner label="Saving…" />
                          ) : (
                            <>
                              <Save size={15} />
                              Save changes
                            </>
                          )}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <div className="document-heading">
                        <h3>
                          Description
                          {!isBacklog && (
                            <span
                              className="ticket-fields-locked"
                              title="All ticket fields are locked after leaving Backlog."
                            >
                              <LockKeyhole size={12} />
                              <span>Read-only</span>
                            </span>
                          )}
                        </h3>
                        {isBacklog && (
                          <button
                            className="icon-button"
                            aria-label="Edit description"
                            onClick={() => {
                              setTitle(ticket.title);
                              setDescription(ticket.description);
                              setPriority(ticket.priority);
                              setImages(ticketImageDrafts(ticket));
                              setEditingDetails(true);
                            }}
                          >
                            <Pencil size={15} />
                          </button>
                        )}
                      </div>
                      {ticket.description ? (
                        <Markdown>{ticket.description}</Markdown>
                      ) : (
                        <p className="empty-description">
                          A little context goes a long way. Add a description to
                          help the team understand this ticket.
                        </p>
                      )}
                      <TicketImages images={ticketImageDrafts(ticket)} />
                    </>
                  )
                ) : tab === "execution" ? (
                  <>
                    <div className="document-heading">
                      <div>
                        <h3>Agent execution</h3>
                        <p className="muted">
                          Saved logs from every run, including conversations.
                        </p>
                      </div>
                      {isAgentStep && ticket.status === "active" && (
                        <button
                          className="button"
                          disabled={!!busy || !!activeRun}
                          onClick={() => void runAgent()}
                        >
                          <Play size={14} />
                          {latestRun?.status === "failed"
                            ? "Retry step"
                            : "Run step"}
                        </button>
                      )}
                    </div>
                    {!ticketRuns.length ? (
                      <EmptyState
                        icon={<Terminal size={25} />}
                        title="Ready when your workflow is."
                      >
                        Agent runs appear here when a ticket enters an agent
                        step. Manual steps do not start a sandbox.
                      </EmptyState>
                    ) : (
                      <div className="run-list">
                        {ticketRuns.map((run) => (
                          <div
                            className={`run-entry ${run.status}`}
                            key={run.id}
                          >
                            <button
                              className="run-entry-header"
                              aria-expanded={showLogs === run.id}
                              onClick={() =>
                                setShowLogs((value) =>
                                  value === run.id ? null : run.id,
                                )
                              }
                            >
                              <span className={`run-status-icon ${run.status}`}>
                                {run.status === "completed" ? (
                                  <Check size={16} />
                                ) : run.status === "failed" ? (
                                  <X size={16} />
                                ) : (
                                  <Clock3 size={16} />
                                )}
                              </span>
                              <span>
                                <strong>
                                  {workflowSteps.find(
                                    (step) => step.id === run.stepId,
                                  )?.name || "Workflow step"}
                                  <span className="run-kind">
                                    {run.kind === "implement"
                                      ? "PR changes"
                                      : run.kind === "definition"
                                        ? "Document"
                                        : "Conversation"}
                                  </span>
                                  {run.noChanges && (
                                    <span className="badge">
                                      No changes · no PR needed
                                    </span>
                                  )}
                                </strong>
                                <small>{dateLabel(run.createdAt)}</small>
                              </span>
                              <span className={`badge run-badge-${run.status}`}>
                                {run.status}{run.cleanupStatus === "pending" ? " · cleanup pending" : ""}
                              </span>
                              <ChevronDown size={15} />
                            </button>
                            {showLogs === run.id && <RunLogPanel run={run} />}
                          </div>
                        ))}
                      </div>
                    )}
                    <ErrorNotice message={history.error} />
                    {history.nextRuns && <button className="button" disabled={!!history.paging} onClick={() => void history.loadMore("runs")}>
                      {history.paging === "runs" ? <Spinner label="Loading…" /> : "Load older runs"}
                    </button>}
                  </>
                ) : tab === "activity" ? (
                  <>
                    <div className="document-heading">
                      <div>
                        <h3>The story of this ticket</h3>
                        <p className="muted">
                          Changes, approvals, and decisions in one place.
                        </p>
                      </div>
                    </div>
                    <ol className="timeline">
                      {data.audit
                        .filter((event) => event.ticketId === ticket.id)
                        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                        .map((event) => (
                          <li key={event.id}>
                            <span className="timeline-dot" />
                            <div>
                              <strong>
                                {event.action.replace(/[._-]/g, " ")}
                              </strong>
                              <p>{event.detail}</p>
                              <small>
                                {data.members.find(
                                  (member) => member.id === event.userId,
                                )?.name ||
                                  (event.userId
                                    ? "Former member"
                                    : "Kangentix")}{" "}
                                · {dateLabel(event.createdAt)}
                              </small>
                            </div>
                          </li>
                        ))}
                    </ol>
                    {!data.audit.some(
                      (event) => event.ticketId === ticket.id,
                    ) && (
                      <p className="muted">
                        No activity has been recorded yet.
                      </p>
                    )}
                    <ErrorNotice message={history.error} />
                    {history.nextAudit && <button className="button" disabled={!!history.paging} onClick={() => void history.loadMore("audit")}>
                      {history.paging === "audit" ? <Spinner label="Loading…" /> : "Load older activity"}
                    </button>}
                  </>
                ) : selectedStep?.kind === "definition" ? (
                  <>
                    <div className="document-heading">
                      <div>
                        <span className="detail-label">STEP DOCUMENT</span>
                        <h3>
                          <FileText size={16} />
                          {artifact?.filename || selectedStep.filename}
                        </h3>
                      </div>
                      <div className="document-actions">
                        {artifact && (
                          <span className="badge">v{artifact.version}</span>
                        )}
                        {canEditDocument && !selectedArtifactDraft && (
                          <button
                            className="button small-button"
                            disabled={!!busy || !!activeRun}
                            onClick={() =>
                              setArtifactDraft({
                                stepId: selectedStep.id,
                                content: artifact?.content || "",
                                version: artifact?.version ?? 0,
                              })
                            }
                          >
                            <Pencil size={13} />
                            {artifact ? "Edit" : "Write"}
                          </button>
                        )}
                        {canEditDocument && (
                          <button
                            className="button small-button"
                            title="Regenerate this step’s document and clear approvals"
                            disabled={
                              !!busy || !!activeRun || !!selectedArtifactDraft
                            }
                            onClick={() => void runAgent()}
                          >
                            <RotateCcw size={13} />
                            {artifact ? "Rerun" : "Generate"}
                          </button>
                        )}
                      </div>
                    </div>
                    {!canEditDocument && (
                      <div className="read-only-label">
                        <LockKeyhole size={13} />
                        {ticket.status === "closed"
                          ? "Preserved with this closed ticket"
                          : "Documents can only be edited in the current workflow step"}
                      </div>
                    )}
                    {selectedArtifactDraft ? (
                      <div className="artifact-editor">
                        <textarea
                          aria-label="Markdown document"
                          value={selectedArtifactDraft.content}
                          disabled={!canEditDocument || !!busy}
                          onChange={(event) =>
                            setArtifactDraft({
                              ...selectedArtifactDraft,
                              content: event.target.value,
                            })
                          }
                          rows={20}
                          spellCheck={false}
                        />
                        <p className="form-hint">
                          Saving a revision clears all approvals for this step.
                          Another member’s edits are protected by version
                          checking.
                        </p>
                        <div className="form-actions">
                          <button
                            className="button"
                            onClick={() => setArtifactDraft(null)}
                            disabled={!!busy}
                          >
                            Cancel
                          </button>
                          <button
                            className="button primary"
                            onClick={() => void saveArtifact()}
                            disabled={
                              !!busy ||
                              !selectedArtifactDraft.content.trim() ||
                              !canEditDocument
                            }
                          >
                            {busy === "artifact" ? (
                              <Spinner label="Saving…" />
                            ) : (
                              <>
                                <Save size={14} />
                                Save document
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    ) : artifact ? (
                      <>
                        <Markdown>{artifact.content}</Markdown>
                        <div className="document-updated">
                          Updated {dateLabel(artifact.updatedAt)} ·{" "}
                          {data.members.find(
                            (member) => member.id === artifact.updatedBy,
                          )?.name || "Kangentix"}
                        </div>
                      </>
                    ) : (
                      <EmptyState
                        icon={<Sparkles size={28} />}
                        title={
                          activeRun?.stepId === tab
                            ? "A little thinking is underway."
                            : "The thinking starts here."
                        }
                      >
                        {activeRun?.stepId === tab
                          ? "Your agent is exploring the repository. The document will appear here when the run completes."
                          : canEditDocument
                            ? "Generate a document with the agent, or start writing one for your team."
                            : "A document will be created when this ticket reaches this step."}
                      </EmptyState>
                    )}
                    {selectedStep.instructions && (
                      <details className="step-instructions">
                        <summary>
                          <Code2 size={14} />
                          Step instructions
                        </summary>
                        <p>{selectedStep.instructions}</p>
                        <small>
                          Model: {selectedStep.model || data.project.model} ·{" "}
                          {selectedStep.includePriorArtifacts
                            ? "Includes prior step documents"
                            : "Current step context only"}
                        </small>
                      </details>
                    )}
                  </>
                ) : null}
              </div>
            </div>
          </section>
          {hasChat && (
            <aside
              className="conversation-panel"
              aria-label="Team conversations"
              hidden={fullScreenPane === "ticket"}
            >
              <div className="conversation-header">
                {selectedThread ? (
                  <>
                    <button
                      className="icon-button"
                      aria-label="Back to all conversations"
                      onClick={() => {
                        setThreadId(null);
                        setPrompt("");
                      }}
                    >
                      <ArrowLeft size={17} />
                    </button>
                    <div>
                      <h3>Conversation</h3>
                      <small>{selectedThread.title}</small>
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <h3>
                        <MessageSquare size={16} />
                        Team conversations
                        <span className="small-count">{threads.length}</span>
                      </h3>
                    </div>
                  </>
                )}
                <button
                  ref={chatExpandButton}
                  className="icon-button"
                  aria-label={
                    fullScreenPane === "chat"
                      ? "Restore chat panel"
                      : "Expand chat to full screen"
                  }
                  title={
                    fullScreenPane === "chat"
                      ? "Restore chat panel"
                      : "Expand chat to full screen"
                  }
                  aria-expanded={fullScreenPane === "chat"}
                  onClick={() =>
                    fullScreenPane === "chat"
                      ? restorePanes()
                      : setExpandedPane("chat")
                  }
                >
                  {fullScreenPane === "chat" ? (
                    <X size={17} />
                  ) : (
                    <Maximize2 size={17} />
                  )}
                </button>
              </div>
              <div className="conversation-scroll">
                {selectedThread ? (
                  <div className="messages">
                    {messages.map((message) => (
                      <div
                        className={`message message-${message.role}`}
                        key={message.id}
                      >
                        <div className="message-author">
                          {message.role === "assistant" ? (
                            <span className="agent-avatar">
                              <Sparkles size={12} />
                            </span>
                          ) : (
                            <Avatar
                              small
                              name={
                                data.members.find(
                                  (member) => member.id === message.authorId,
                                )?.name || "Team member"
                              }
                            />
                          )}
                          <strong>
                            {message.role === "assistant"
                              ? "Kangentix"
                              : message.role === "system"
                                ? "System"
                                : data.members.find(
                                    (member) => member.id === message.authorId,
                                  )?.name || "Team member"}
                          </strong>
                          <small>{dateLabel(message.createdAt)}</small>
                        </div>
                        <Markdown>{message.content}</Markdown>
                      </div>
                    ))}
                    {activeRun?.threadId === selectedThread.id && (
                      <div className="agent-thinking">
                        <Sparkles size={13} className="pulse" />
                        {activeRun.status === "pending"
                          ? "Waiting for the agent…"
                          : "Kangentix is thinking…"}
                      </div>
                    )}
                  </div>
                ) : threads.length ? (
                  <div className="thread-list">
                    {threads.map((thread) => {
                      const first = data.messages
                        .filter((message) => message.threadId === thread.id)
                        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
                      const response = first.find(
                        (message) => message.role === "assistant",
                      );
                      return (
                        <button
                          className="thread-card"
                          key={thread.id}
                          onClick={() => {
                            setThreadId(thread.id);
                            setPrompt("");
                          }}
                        >
                          <span className="thread-meta">
                            <Avatar
                              small
                              name={
                                data.members.find(
                                  (member) => member.id === thread.createdBy,
                                )?.name || "Team member"
                              }
                            />
                            <span>
                              {data.members.find(
                                (member) => member.id === thread.createdBy,
                              )?.name || "Team member"}
                            </span>
                            <ArrowRight size={13} />
                          </span>
                          <strong>
                            {first.find((message) => message.role === "user")
                              ?.content || thread.title}
                          </strong>
                          {response && (
                            <span className="thread-reply">
                              <Sparkles size={13} />
                              <span>{response.content.slice(0, 165)}</span>
                            </span>
                          )}
                          <span className="thread-footer">
                            {first.length} messages ·{" "}
                            {dateLabel(thread.createdAt)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="chat-empty">
                    <MessageSquare size={28} />
                    <h4>A question can change everything.</h4>
                    <p>
                      Ask about the repository, explore an approach, or request
                      a document revision. Each new prompt starts a separate
                      conversation.
                    </p>
                  </div>
                )}
              </div>
              {canEditDocument ? (
                <form className="chat-composer" onSubmit={sendPrompt}>
                  <label className="sr-only" htmlFor="thread-prompt">
                    {selectedThread
                      ? "Reply to conversation"
                      : "Start a conversation"}
                  </label>
                  <div className="chat-input-row">
                    <textarea
                      id="thread-prompt"
                      value={prompt}
                      onChange={(event) => setPrompt(event.target.value)}
                      placeholder={
                        selectedThread
                          ? "Keep the conversation going…"
                          : "Ask a question or request a revision…"
                      }
                      rows={2}
                      maxLength={20000}
                      disabled={!!busy}
                    />
                    <button
                      className="send-button"
                      type="submit"
                      aria-label={
                        selectedThread ? "Send reply" : "Start conversation"
                      }
                      disabled={!!busy || !canChat || !prompt.trim()}
                    >
                      {busy === "chat" ? (
                        <Spinner label="" />
                      ) : (
                        <Send size={16} />
                      )}
                    </button>
                  </div>
                  <span className="chat-composer-hint">
                    {activeRun
                      ? "Waiting for the current run to finish"
                      : selectedThread
                        ? "Visible to your project team"
                        : "New prompt · new thread"}
                  </span>
                </form>
              ) : (
                <div className="chat-readonly">
                  <LockKeyhole size={13} />
                  Conversation history is preserved. This step is read-only.
                </div>
              )}
            </aside>
          )}
        </div>
        {!isBacklog && (
          <footer className="ticket-actionbar">
            {workflowSteps.length > 0 && (
              <div className="ticket-journey">
                <span className="detail-label">THE PATH AHEAD</span>
                <div>
                  {workflowSteps
                    .map((step) => ({ id: step.id, name: step.name }))
                    .map((step, index) => (
                      <span
                        key={step.id}
                        className={step.id === ticket.stepId ? "current" : ""}
                      >
                        {index > 0 && <ChevronDown size={13} />}
                        <i />
                        {step.name}
                      </span>
                    ))}
                </div>
              </div>
            )}
            <div className="actionbar-buttons">
              {ticket.status === "active" &&
                data.sprints.some(
                  (sprint) => sprint.id === ticket.sprintId && !sprint.endedAt,
                ) && (
                  <button
                    className="button"
                    disabled={!!busy || !!activeRun || !!artifactDraft}
                    title={
                      activeRun
                        ? "Wait for the running agent to finish."
                        : artifactDraft
                          ? "Save or cancel your document edits first."
                          : "Return to Backlog and clear approvals. Rejoining a sprint starts at the first step."
                    }
                    onClick={() =>
                      void action("backlog", async () => {
                        await api(`/tickets/${ticket.id}/backlog`, "POST");
                        setTab("overview");
                        setThreadId(null);
                        setPrompt("");
                        setArtifactDraft(null);
                        setEditingDetails(false);
                        notify(
                          `${ticket.number} returned to Backlog. Approvals cleared.`,
                        );
                      })
                    }
                  >
                    {busy === "backlog" ? (
                      <Spinner label="Moving…" />
                    ) : (
                      <>
                        <ArrowLeft size={15} />
                        Move to Backlog
                      </>
                    )}
                  </button>
                )}
              {ticket.status === "active" &&
                currentStep &&
                (ownApproval || eligible) &&
                requiredApprovals > 0 && (
                  <button
                    className={`button ${ownApproval ? "approved-button" : ""}`}
                    disabled={
                      !!busy ||
                      !!activeRun ||
                      !!needsArtifact ||
                      needsImplementation ||
                      !!artifactDraft
                    }
                    onClick={() =>
                      void action("approval", async () => {
                        if (ownApproval)
                          await api(
                            `/tickets/${ticket.id}/approvals/${currentStep.id}`,
                            "DELETE",
                          );
                        else
                          await api(`/tickets/${ticket.id}/approvals`, "POST", {
                            stepId: currentStep.id,
                            ...(currentStep.kind === "definition"
                              ? { artifactVersion: currentArtifact?.version }
                              : {}),
                            ...(currentStep.kind === "implement"
                              ? {
                                  runId: data.runs
                                    .filter(
                                      (run) =>
                                        run.ticketId === ticket.id &&
                                        run.stepId === currentStep.id &&
                                        run.kind === "implement",
                                    )
                                    .at(-1)?.id,
                                }
                              : {}),
                          });
                      })
                    }
                  >
                    {busy === "approval" ? (
                      <Spinner label="Saving…" />
                    ) : ownApproval ? (
                      <>
                        <Check size={15} />
                        Revoke approval
                      </>
                    ) : (
                      <>
                        <ShieldCheck size={15} />
                        Approve step
                      </>
                    )}
                  </button>
                )}
              {ticket.status === "active" &&
                currentStep?.kind === "implement" && (
                  <button
                    className={`button ${needsImplementation ? "primary" : ""}`}
                    disabled={!!busy || !!activeRun}
                    onClick={() => void runAgent()}
                  >
                    {busy === "run" ? (
                      <Spinner label="Starting…" />
                    ) : (
                      <>
                        <Play size={15} />
                        {activeRun
                          ? "Agent running…"
                          : implementationComplete
                            ? "Rerun agent"
                            : latestRun?.status === "failed"
                              ? "Retry agent"
                              : "Run agent"}
                      </>
                    )}
                  </button>
                )}
              {ticket.status !== "closed" && (
                <button
                  className="button primary"
                  disabled={
                    !!busy ||
                    !!activeRun ||
                    (ticket.status === "active" &&
                      (!approvalsMet ||
                        !!needsArtifact ||
                        generationFailed ||
                        needsImplementation)) ||
                    !!artifactDraft
                  }
                  title={
                    generationFailed
                      ? "Retry the failed generation successfully before advancing."
                      : needsImplementation
                        ? "Complete this agent step before approving and advancing."
                        : !approvalsMet
                          ? "Collect the required approvals for this step before continuing."
                          : needsArtifact
                            ? "Generate or write this step’s document first."
                            : undefined
                  }
                  onClick={() =>
                    void action("next", async () => {
                      await api(`/tickets/${ticket.id}/next`, "POST");
                      notify(
                        completesTicket
                          ? `${ticket.number} marked Done and moved to the Done archive.`
                          : "Ticket moved to the next step.",
                      );
                    })
                  }
                >
                  {busy === "next" ? (
                    <Spinner label="Moving…" />
                  ) : (
                    <>
                      {completesTicket ? "Mark as Done" : "Next step"}
                      {completesTicket ? (
                        <CheckCheck size={16} />
                      ) : (
                        <ArrowRight size={16} />
                      )}
                    </>
                  )}
                </button>
              )}
            </div>
          </footer>
        )}
      </div>
    </Modal>
  );
}
