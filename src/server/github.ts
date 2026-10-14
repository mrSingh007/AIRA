import { createHash } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abortableDelay, credentialScope, FairPreparationGate, providerCooldown, RetryablePreparationError, throttledResponse } from "./preparation.js";

const API = "https://api.github.com";
const MAX_ARCHIVE = 100 * 1024 * 1024;
export interface GitEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
}
export interface RepositorySnapshot {
  sha: string;
  treeSha: string;
  entries: GitEntry[];
  archivePath: string;
  archiveSize: number;
  dispose(): Promise<void>;
}
export interface FileChange {
  path: string;
  mode: "100644" | "100755" | "120000";
  content: string | null;
}

export function repositoryPath(repository: string): string {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    repository.split("/").some((p) => p === "." || p === "..")
  )
    throw new Error("Use a GitHub repository in owner/repository form.");
  return `/repos/${repository}`;
}
async function githubRequest<T>(
  token: string,
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const scope = credentialScope("github", token);
  const cooldown = providerCooldown(scope);
  if (cooldown) throw new RetryablePreparationError("GitHub account is cooling down after throttling.", scope, cooldown);
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const pressure = throttledResponse(response, scope);
    if (pressure) throw pressure;
    const data = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new Error(
      `GitHub ${response.status}: ${data.message || response.statusText}`,
    );
  }
  return response.json() as Promise<T>;
}
export async function verifyGitHubConnection(
  token: string,
  repository?: string,
): Promise<{
  identity: string;
  repositories: Array<{ fullName: string; defaultBranch: string }>;
}> {
  if (!token)
    throw new Error("Add a GitHub access token in project configuration.");
  const identity = await githubRequest<{ login: string }>(token, "/user");
  type Repo = {
    full_name: string;
    default_branch: string;
    permissions?: { push?: boolean };
    archived?: boolean;
  };
  const repositories: Repo[] = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await githubRequest<Repo[]>(
      token,
      `/user/repos?per_page=100&sort=updated&page=${page}`,
    );
    repositories.push(
      ...batch.filter((repo) => repo.permissions?.push && !repo.archived),
    );
    if (batch.length < 100) break;
  }
  if (repository) {
    const selected = await githubRequest<Repo>(token, repositoryPath(repository));
    if (!selected.permissions?.push || selected.archived)
      throw new Error(
        "The GitHub identity needs write access to a repository that is not archived.",
      );
    if (
      !repositories.some(
        (repo) =>
          repo.full_name.toLowerCase() === selected.full_name.toLowerCase(),
      )
    )
      repositories.unshift(selected);
  }
  return {
    identity: identity.login,
    repositories: repositories.map((repo) => ({
      fullName: repo.full_name,
      defaultBranch: repo.default_branch,
    })),
  };
}
// File storage remains reserved after failed deletion, so repeated cleanup
// failures cannot accumulate more than four archives outside preparation.
const archiveStorage = new FairPreparationGate(4);
const failedArchiveCleanups = new Map<() => Promise<void>, { attempt: number; timer?: ReturnType<typeof setTimeout> }>();
function retryArchiveCleanup(cleanup: () => Promise<void>) {
  let entry = failedArchiveCleanups.get(cleanup);
  if (!entry) { entry = { attempt: 0 }; failedArchiveCleanups.set(cleanup, entry); }
  if (entry.timer) return;
  const delay = Math.min(60_000, 1_000 * 2 ** Math.min(entry.attempt++, 6));
  entry.timer = setTimeout(() => {
    entry!.timer = undefined;
    void cleanup().catch(() => { /* cleanup schedules its next bounded retry */ });
  }, delay);
  entry.timer.unref();
}

export async function boundedArchive(response: Response, limit: number, signal?: AbortSignal): Promise<{ path: string; size: number; dispose(): Promise<void> }> {
  if (!response.body)
    throw new Error("GitHub returned an empty repository archive.");
  let releaseStorage: () => void;
  try { releaseStorage = await archiveStorage.acquire("archives", signal); }
  catch (error) { await response.body.cancel().catch(() => undefined); throw error; }
  let directory: string;
  try { directory = await mkdtemp(join(tmpdir(), "kangentix-snapshot-")); }
  catch (error) { releaseStorage(); await response.body.cancel(); throw error; }
  const path = join(directory, "repository.tar.gz");
  let cleanupDone = false;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    if (cleanupDone) return Promise.resolve();
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = rm(directory, { recursive: true, force: true }).then(() => {
      cleanupDone = true;
      const failed = failedArchiveCleanups.get(cleanup);
      if (failed?.timer) clearTimeout(failed.timer);
      failedArchiveCleanups.delete(cleanup);
      releaseStorage();
    }).catch((error) => {
      retryArchiveCleanup(cleanup);
      throw error;
    }).finally(() => { cleanupPromise = undefined; });
    return cleanupPromise;
  };
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let size = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    file = await open(path, "wx", 0o600);
    reader = response.body.getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit)
        throw new Error(
          "Repository archive exceeds the 100 MiB transfer limit.",
        );
      await file.writeFile(next.value);
    }
    await file.close();
    file = undefined;
  } catch (error) {
    try { await file?.close(); }
    finally {
      try { await cleanup(); }
      catch { /* File storage remains reserved and cleanup retries with backoff. */ }
    }
    throw error;
  } finally {
    if (reader) await reader.cancel().catch(() => { /* Body may already be closed by cancellation. */ });
    else await response.body.cancel().catch(() => { /* Cancel a response if file creation failed. */ });
  }
  return { path, size, dispose: cleanup };
}
type Archive = Awaited<ReturnType<typeof boundedArchive>>;
const archives = new Map<string, { refs: number; promise: Promise<Archive>; controller: AbortController }>();

export async function getRepositorySnapshot(
  token: string,
  repository: string,
  branch: string,
  signal?: AbortSignal,
): Promise<RepositorySnapshot> {
  const path = repositoryPath(repository);
  if (!branch || branch.length > 250)
    throw new Error("Set a valid repository base branch.");
  const ref = await githubRequest<{ object: { sha: string } }>(
    token,
    `${path}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
    undefined, "GET", signal,
  );
  const commit = await githubRequest<{ sha: string; tree: { sha: string } }>(
    token,
    `${path}/git/commits/${ref.object.sha}`,
    undefined, "GET", signal,
  );
  const tree = await githubRequest<{ tree: GitEntry[]; truncated: boolean }>(
    token,
    `${path}/git/trees/${commit.tree.sha}?recursive=1`,
    undefined, "GET", signal,
  );
  if (tree.truncated || tree.tree.length > 30_000)
    throw new Error(
      "Repository tree is too large for this release (30,000 entries maximum).",
    );
  if (tree.tree.some((entry) => entry.type === "commit"))
    throw new Error(
      "Repositories containing Git submodules are not supported yet.",
    );
  const key = `${credentialScope("github", token)}:${repository.toLowerCase()}:${commit.sha}`;
  let cached = archives.get(key);
  if (!cached) {
    const controller = new AbortController();
    cached = { refs: 0, promise: downloadArchive(token, path, commit.sha, controller.signal), controller };
    archives.set(key, cached);
  }
  cached.refs++;
  let referenceReleased = false;
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    if (!referenceReleased) {
      referenceReleased = true;
      if (--cached!.refs > 0) { disposed = true; return; }
      archives.delete(key);
      cached!.controller.abort();
    }
    const archive = await cached!.promise.catch(() => undefined);
    if (archive) await archive.dispose();
    disposed = true;
  };
  let abort: (() => void) | undefined;
  try {
    // A cancelled consumer releases its reference; only the last consumer cancels the shared transfer.
    const archive = await (signal ? Promise.race([cached.promise, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason ?? new Error("Repository preparation cancelled."));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]) : cached.promise);
    signal?.throwIfAborted();
    return { sha: commit.sha, treeSha: commit.tree.sha, entries: tree.tree.filter((entry) => entry.type === "blob"), archivePath: archive.path, archiveSize: archive.size, dispose };
  } catch (error) { await dispose(); throw error; }
  finally { if (abort) signal?.removeEventListener("abort", abort); }
}

async function downloadArchive(token: string, path: string, sha: string, signal: AbortSignal): Promise<Archive> {
  // GitHub returns a short-lived codeload URL. Never forward the bearer token to a redirect target.
  const archiveResponse = await fetch(`${API}${path}/tarball/${sha}`, {
    redirect: "manual",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
  });
  let response = archiveResponse;
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location || new URL(location).origin !== "https://codeload.github.com")
      throw new Error(
        "GitHub returned an unexpected archive download location.",
      );
    response = await fetch(location, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      redirect: "error",
    });
  }
  if (!response.ok)
    throw throttledResponse(response, credentialScope("github", token)) ?? new Error(`Could not download repository archive (${response.status}).`);
  return boundedArchive(response, MAX_ARCHIVE, signal);
}
export function validateFileChanges(
  value: unknown,
  snapshot: RepositorySnapshot,
): FileChange[] {
  if (!Array.isArray(value) || value.length > 500)
    throw new Error("Implementation must change at most 500 files.");
  const original = new Map(
    snapshot.entries.map((entry) => [entry.path, entry]),
  );
  let bytes = 0;
  const paths = new Set<string>();
  const changes: FileChange[] = [];
  for (const item of value) {
    if (
      !item ||
      typeof item.path !== "string" ||
      item.path.length > 1000 ||
      item.path.startsWith("/") ||
      item.path.includes("\\") ||
      /[\x00-\x1f\x7f]/.test(item.path) ||
      item.path
        .split("/")
        .some(
          (p: string) =>
            !p || p === "." || p === ".." || p.toLowerCase() === ".git",
        )
    )
      throw new Error("Sandbox returned an unsafe repository path.");
    if (paths.has(item.path))
      throw new Error("Sandbox returned duplicate repository paths.");
    paths.add(item.path);
    if (!["100644", "100755", "120000"].includes(item.mode))
      throw new Error("Sandbox returned an unsupported file mode.");
    if (item.content === null) {
      if (original.has(item.path)) changes.push(item as FileChange);
      continue;
    }
    if (typeof item.content !== "string")
      throw new Error("Sandbox returned invalid file contents.");
    if (item.content.length > 4 * Math.ceil((5 * 1024 * 1024) / 3))
      throw new Error("Implementation exceeds the 5 MiB per-file transfer limit.");
    const content = Buffer.from(item.content, "base64");
    // Re-encoding enforces canonical base64 without a nested repetition regex,
    // which can exhaust the RegExp stack on otherwise valid large files.
    if (content.toString("base64") !== item.content)
      throw new Error("Sandbox returned invalid file contents.");
    bytes += content.length;
    if (content.length > 5 * 1024 * 1024 || bytes > 20 * 1024 * 1024)
      throw new Error(
        "Implementation exceeds file transfer limits (5 MiB per file, 20 MiB total).",
      );
    if (item.mode === "120000") {
      const target = content.toString("utf8");
      const parts = item.path.split("/").slice(0, -1);
      if (
        !target ||
        target.startsWith("/") ||
        target.includes("\\") ||
        /[\x00-\x1f]/.test(target)
      )
        throw new Error("Implementation contains an unsafe symbolic link.");
      for (const part of target.split("/")) {
        if (part === "..") {
          if (!parts.length)
            throw new Error("Symbolic link leaves repository.");
          parts.pop();
        } else if (part !== ".") parts.push(part);
      }
      if (parts.some((part: string) => part.toLowerCase() === ".git"))
        throw new Error("Symbolic link targets Git metadata.");
    }
    const sha = createHash("sha1")
      .update(`blob ${content.length}\0`)
      .update(content)
      .digest("hex");
    const previous = original.get(item.path);
    if (previous?.sha !== sha || previous.mode !== item.mode)
      changes.push({ path: item.path, mode: item.mode, content: item.content });
  }
  return changes;
}
async function publishImplementationPr(
  options: {
    token: string;
    repository: string;
    baseBranch: string;
    snapshot: RepositorySnapshot;
    changes: FileChange[];
    ticketNumber: string;
    title: string;
    runId: string;
    reply: string;
    signal?: AbortSignal;
  },
  onLog: (line: string) => Promise<void>,
): Promise<{ prNumber: number; prUrl: string }> {
  const { token, repository, baseBranch, snapshot, changes } = options;
  const request = async <T>(token: string, path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      options.signal?.throwIfAborted();
      try { return await githubRequest<T>(token, path, body, method, options.signal); }
      catch (error) {
        // Explicit HTTP throttling rejected the operation; ambiguous network/write failures are never replayed here.
        if (!(error instanceof RetryablePreparationError) || attempt >= 2) throw error;
        await onLog(`GitHub publication waiting ${Math.ceil(error.retryAfterMs / 1000)} seconds for account throttling.`);
        await abortableDelay(error.retryAfterMs, options.signal);
      }
    }
  };
  if (!changes.length)
    throw new Error("The implementation produced no repository changes.");
  const path = repositoryPath(repository);
  const branch = `kangentix/${options.ticketNumber.toLowerCase().replace(/[^a-z0-9-]/g, "-")}/${options.runId.replace(/[^a-z0-9-]/g, "")}`;
  type PullRequest = {
    number: number;
    html_url: string;
    head: { ref: string; sha: string; repo: { full_name: string } | null };
    base: { ref: string; repo: { full_name: string } | null };
  };
  const findExisting = () =>
    request<PullRequest[]>(
      token,
      `${path}/pulls?state=all&head=${encodeURIComponent(repository.split("/")[0] + ":" + branch)}&base=${encodeURIComponent(baseBranch)}`,
    );
  const existing = await findExisting();
  await onLog(`Publishing ${changes.length} changed files to ${branch}.`);
  const tree: Array<{
    path: string;
    mode: string;
    type: string;
    sha: string | null;
  }> = [];
  for (const file of changes) {
    const blob =
      file.content === null
        ? null
        : await request<{ sha: string }>(token, `${path}/git/blobs`, {
            encoding: "base64",
            content: file.content,
          });
    tree.push({
      path: file.path,
      mode: file.mode,
      type: "blob",
      sha: blob?.sha ?? null,
    });
  }
  const newTree = await request<{ sha: string }>(token, `${path}/git/trees`, {
    base_tree: snapshot.treeSha,
    tree,
  });
  const verifyPr = async (number: number) => {
    const verified = await request<PullRequest>(token, `${path}/pulls/${number}`);
    const url = new URL(verified.html_url);
    if (
      verified.number !== number ||
      verified.head.ref !== branch ||
      verified.base.ref !== baseBranch ||
      verified.head.repo?.full_name.toLowerCase() !== repository.toLowerCase() ||
      verified.base.repo?.full_name.toLowerCase() !== repository.toLowerCase() ||
      url.origin !== "https://github.com" ||
      url.pathname.toLowerCase() !== `/${repository}/pull/${number}`.toLowerCase()
    )
      throw new Error("GitHub pull request verification failed.");
    const head = await request<{
      tree: { sha: string };
      parents: Array<{ sha: string }>;
    }>(
      token,
      `${path}/git/commits/${verified.head.sha}`,
    );
    if (
      head.tree.sha !== newTree.sha ||
      head.parents.length !== 1 ||
      head.parents[0].sha !== snapshot.sha
    )
      throw new Error(
        "GitHub pull request does not contain the expected implementation snapshot.",
      );
    return { prNumber: verified.number, prUrl: verified.html_url };
  };
  // Retries must verify repository identity and contents as strictly as new PRs.
  if (existing[0]) return verifyPr(existing[0].number);
  const commit = await request<{ sha: string }>(token, `${path}/git/commits`, {
    message: `${options.ticketNumber}: ${options.title}`,
    tree: newTree.sha,
    parents: [snapshot.sha],
  });
  try {
    await request(token, `${path}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: commit.sha,
    });
  } catch (error) {
    // A previous request can have succeeded before a network failure. Reuse only an identical tree.
    const reference = await request<{ object: { sha: string } }>(
      token,
      `${path}/git/ref/heads/${branch}`,
    ).catch(() => null);
    const previous =
      reference &&
      (await request<{
        tree: { sha: string };
        parents: Array<{ sha: string }>;
      }>(
        token,
        `${path}/git/commits/${reference.object.sha}`,
      ));
    if (
      !previous ||
      previous.tree.sha !== newTree.sha ||
      previous.parents.length !== 1 ||
      previous.parents[0].sha !== snapshot.sha
    )
      throw error;
  }
  let pr: { number: number; html_url: string };
  try {
    pr = await request(token, `${path}/pulls`, {
      title: `${options.ticketNumber}: ${options.title}`.slice(0, 250),
      head: branch,
      base: baseBranch,
      body: `Implements ${options.ticketNumber} from Kangentix.\n\nBase snapshot: \`${snapshot.sha}\`\n\n${options.reply.slice(0, 20_000)}\n\nTicket artifacts are included under \`docs/kangentix/${options.ticketNumber}/\`.`,
    });
  } catch (error) {
    const found = await findExisting();
    if (!found[0]) throw error;
    pr = found[0];
  }
  const verified = await verifyPr(pr.number);
  await onLog(`Created pull request #${verified.prNumber}: ${verified.prUrl}`);
  return verified;
}

const publications = new Map<string, FairPreparationGate>();
export async function createImplementationPr(options: Parameters<typeof publishImplementationPr>[0], onLog: (line: string) => Promise<void>) {
  const scope = credentialScope("github", options.token);
  let gate = publications.get(scope);
  if (!gate) { gate = new FairPreparationGate(1); publications.set(scope, gate); }
  await onLog("Waiting for GitHub publication capacity for this credential scope.");
  const release = await gate.acquire(options.repository, options.signal);
  try { return await publishImplementationPr(options, onLog); }
  finally { release(); if (!gate.occupancy && !gate.waiting) publications.delete(scope); }
}
