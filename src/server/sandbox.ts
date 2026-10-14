import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";
import { ApiClient, ConnectionConfig, RateLimitError, Sandbox, ServiceBusyError } from "@e2b/code-interpreter";
import type { RunContext } from "../shared/types.js";
import { DEFAULT_E2B_TEMPLATE } from "../shared/types.js";
import { credentialScope, providerCooldown, recordProviderCooldown, RetryablePreparationError } from "./preparation.js";

export interface SandboxResource {
  provider: "docker" | "e2b";
  id: string;
  expiresAt: string;
}
export interface SandboxLifecycleOptions {
  signal?: AbortSignal;
  onCreating?(provider: SandboxResource["provider"], expiresAt: string): Promise<void>;
  onCreated?(resource: SandboxResource): Promise<void>;
  onDisposed?(): Promise<void>;
}
export interface AgentSandbox {
  resource: SandboxResource;
  put(name: string, data: Buffer | string): Promise<void>;
  putFile(name: string, path: string, size: number): Promise<void>;
  command(action: "prepare" | "run" | "export", onLog: (line: string) => Promise<void>): Promise<void>;
  read(name: string, maxBytes: number): Promise<string>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}
export const runTimeoutMs = Math.max(60_000, Math.min(3_000_000, Number(process.env.RUN_TIMEOUT_SECONDS || 900) * 1000 || 900_000));
const OUTPUT_LIMIT = 32 * 1024 * 1024;
const ROOT = "/tmp/kangentix";
export const sandboxOwnerId = () => createHash("sha256").update(process.env.APP_SECRET || "").digest("hex").slice(0, 24);

export class E2BCreationRefusedError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "E2BCreationRefusedError"; }
}
/** Separate the control-plane POST from SDK connection/provisioning so ownership is durable first. */
export const e2bControlPlane = {
  async create(template: string, credential: string, lifetimeMs: number, metadata: Record<string, string>, signal?: AbortSignal): Promise<string> {
    const config = new ConnectionConfig({ apiKey: credential, requestTimeoutMs: 60_000, retries: 0, signal });
    const result = await new ApiClient(config).api.POST("/v2/sandboxes", {
      body: { templateID: template, timeout: Math.ceil(lifetimeMs / 1000), metadata },
      signal: config.getSignal(60_000, signal),
    });
    if (!result.response.ok) {
      const message = `E2B ${result.response.status}: ${result.error?.message || result.response.statusText}`;
      if ([400, 401, 403, 404, 422, 429, 503].includes(result.response.status))
        throw new E2BCreationRefusedError(result.response.status, message);
      throw new Error(message);
    }
    if (!result.data || typeof result.data.sandboxID !== "string" || !result.data.sandboxID)
      throw new Error("E2B creation response did not identify the created sandbox; ownership discovery is required.");
    return result.data.sandboxID;
  },
};
const validName = (name: string) => {
  if (!/^[a-z][a-z0-9.-]*$/.test(name)) throw new Error("Invalid sandbox transfer filename.");
  return name;
};

/** Redact before chunk/line splitting, retaining only a bounded possible credential prefix. */
class SecretStreamRedactor {
  private carry = "";
  private readonly secrets: string[];
  private readonly retain: number;
  constructor(secrets: string[]) {
    this.secrets = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
    this.retain = Math.max(0, ...this.secrets.map((secret) => secret.length - 1));
  }
  write(chunk: string): string {
    const text = this.carry + chunk;
    let boundary = Math.max(0, text.length - this.retain);
    // Move a boundary through a complete match to its end, so replaceAll sees
    // the entire credential before any part reaches a downstream log buffer.
    let extended: boolean;
    do {
      extended = false;
      for (const secret of this.secrets) {
        const start = Math.max(0, boundary - secret.length + 1);
        const match = text.indexOf(secret, start);
        if (match >= 0 && match < boundary && match + secret.length > boundary) {
          boundary = match + secret.length;
          extended = true;
        }
      }
    } while (extended);
    this.carry = text.slice(boundary);
    return this.redact(text.slice(0, boundary));
  }
  flush(): string {
    const text = this.redact(this.carry);
    this.carry = "";
    return text;
  }
  private redact(text: string) {
    for (const secret of this.secrets) text = text.replaceAll(secret, "[REDACTED]");
    return text;
  }
}

/** Await each callback; no retained chain of per-line persistence promises. */
export function lineOutput(onLine: (line: string) => Promise<void>, maxBytes = OUTPUT_LIMIT, secrets: string[] = []) {
  const pending = { stdout: "", stderr: "" };
  const redactors = { stdout: new SecretStreamRedactor(secrets), stderr: new SecretStreamRedactor(secrets) };
  let bytes = 0;
  const append = async (chunk: string, stream: "stdout" | "stderr") => {
      const text = pending[stream] + chunk;
      let start = 0;
      for (let end = 0; end < text.length; end++) {
        if (text[end] === "\n" || end - start >= 30_000) {
          await onLine(text.slice(start, end));
          start = text[end] === "\n" ? end + 1 : end;
        }
      }
      pending[stream] = text.slice(start);
  };
  return {
    async write(chunk: string, stream: "stdout" | "stderr") {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) throw new Error("Sandbox output exceeded the transfer limit.");
      await append(redactors[stream].write(chunk), stream);
    },
    async flush() {
      for (const stream of ["stdout", "stderr"] as const) {
        await append(redactors[stream].flush(), stream);
        if (pending[stream]) await onLine(pending[stream]);
        pending[stream] = "";
      }
    },
  };
}

async function processCommand(args: string[], timeoutMs = 60_000, onLine?: (line: string) => Promise<void>, maxBytes = OUTPUT_LIMIT, input?: Buffer | string | Readable, stdoutOnly = false, signal?: AbortSignal, secrets: string[] = []): Promise<string> {
  signal?.throwIfAborted();
  const child = spawn("docker", args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  let failure: unknown;
  let size = 0;
  let tail = "";
  const chunks: Buffer[] = [];
  const logs = onLine ? lineOutput(onLine, maxBytes, secrets) : undefined;
  const errorOutput = lineOutput(async (line) => { tail = (tail + line + "\n").slice(-4_000); }, maxBytes, secrets);
  const kill = (error: unknown) => { failure ??= error; child.kill("SIGKILL"); };
  const abort = () => kill(signal?.reason ?? new Error("Sandbox command cancelled."));
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => kill(new Error("Sandbox command timed out.")), timeoutMs);
  const completion = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const receive = async (stream: Readable, stdout: boolean) => {
    const decoder = new StringDecoder("utf8");
    const outputStream = stdout ? "stdout" : "stderr";
    try {
      for await (const part of stream) {
        const data = Buffer.from(part);
        size += data.length;
        if (size > maxBytes) throw new Error("Sandbox output exceeded the transfer limit.");
        const text = decoder.write(data);
        await errorOutput.write(text, outputStream);
        if (logs) await logs.write(text, outputStream);
        else if (!stdoutOnly || stdout) chunks.push(data);
      }
      const final = decoder.end();
      if (final) {
        await errorOutput.write(final, outputStream);
        await logs?.write(final, outputStream);
      }
    } catch (error) { kill(error); }
  };
  const transfer = async () => {
    if (input === undefined || !child.stdin) return;
    try {
      // The bounded stream prevents one archive buffer per executing sandbox.
      const source = typeof input === "string" || Buffer.isBuffer(input) ? Readable.from([input]) : input;
      const { pipeline } = await import("node:stream/promises");
      await pipeline(source, child.stdin);
    } catch (error) { kill(error); }
  };
  try {
    const results = await Promise.allSettled([completion, receive(child.stdout!, true), receive(child.stderr!, false), transfer()]);
    if (failure) throw failure;
    const exited = results[0];
    if (exited.status === "rejected") throw new Error(`Docker could not start: ${exited.reason instanceof Error ? exited.reason.message : "unknown error"}`);
    await logs?.flush();
    await errorOutput.flush();
    if (exited.value !== 0) throw new Error(`Docker command failed (${exited.value}): ${tail}`);
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export async function disposeOwnedSandbox(resource: SandboxResource, credential = ""): Promise<void> {
  if (resource.provider === "e2b") {
    // Installed e2b SDK static kill returns false when the resource is already absent.
    await Sandbox.kill(resource.id, { apiKey: credential, requestTimeoutMs: 30_000, retries: 0 });
    return;
  }
  let owner: string;
  try { owner = (await processCommand(["inspect", "--format", '{{ index .Config.Labels "kangentix.owner" }}', resource.id], 30_000)).trim(); }
  catch (error) {
    if (error instanceof Error && /No such (object|container)/i.test(error.message)) return;
    throw error;
  }
  if (owner !== sandboxOwnerId()) throw new Error("Refusing to remove a Docker sandbox owned by another Kangentix installation.");
  await processCommand(["rm", "-f", resource.id], 30_000);
}

export async function discoverOwnedSandboxes(projectId: string, runId: string, provider: SandboxResource["provider"], credential = ""): Promise<SandboxResource[]> {
  const owner = sandboxOwnerId();
  if (provider === "e2b") {
    // The installed SDK lists both running and paused sandboxes through an explicitly paginated API.
    const paginator = Sandbox.list({ apiKey: credential, requestTimeoutMs: 30_000, retries: 0, query: { metadata: { app: "kangentix", owner, projectId, runId } }, limit: 100 });
    const found: SandboxResource[] = [];
    while (paginator.hasNext) {
      for (const item of await paginator.nextItems()) {
        if (item.metadata.owner === owner && item.metadata.projectId === projectId && item.metadata.runId === runId)
          found.push({ provider, id: item.sandboxId, expiresAt: item.endAt.toISOString() });
      }
    }
    return found;
  }
  const text = await processCommand(["ps", "-a", "--no-trunc", "--filter", "label=app=kangentix-sandbox", "--filter", `label=kangentix.owner=${owner}`, "--filter", `label=kangentix.project=${projectId}`, "--filter", `label=kangentix.run=${runId}`, "--format", '{{.ID}}|{{.Label "kangentix.expires"}}'], 30_000);
  return text.trim().split("\n").filter(Boolean).map((line) => {
    const [id, expiresAt] = line.split("|");
    if (!/^[a-f0-9]{64}$/.test(id) || !Number.isFinite(Date.parse(expiresAt))) throw new Error("Docker discovery returned invalid ownership metadata.");
    return { provider, id, expiresAt };
  });
}

export async function createAgentSandbox(context: RunContext, onLog: (line: string) => Promise<void>, options: SandboxLifecycleOptions = {}): Promise<AgentSandbox> {
  const { signal } = options;
  const secrets = Object.values(context.credentials).filter(Boolean);
  signal?.throwIfAborted();
  const provider = context.project.sandboxProvider;
  // An ambiguous E2B POST may consume its full request deadline before we know
  // whether creation succeeded. Reserve through that window plus provider TTL.
  const expiresAt = new Date(Date.now() + runTimeoutMs + 240_000 + (provider === "e2b" ? 60_000 : 0)).toISOString();
  let resource: SandboxResource | undefined;
  let result: AgentSandbox;
  if (provider === "e2b") {
    const credential = context.credentials.e2bApiKey;
    if (!credential) throw new Error("Add an E2B API key in project configuration.");
    const scope = credentialScope("e2b", credential);
    const cooldown = providerCooldown(scope);
    if (cooldown) throw new RetryablePreparationError("E2B account is cooling down after capacity throttling.", scope, cooldown);
    await onLog("Starting a fresh E2B sandbox. A prepared template avoids per-run CLI installation.");
    await options.onCreating?.(provider, expiresAt);
    let sandbox: Sandbox;
    try {
      // Retries are disabled: an ambiguous creation must be discovered by ownership metadata first.
      const id = await e2bControlPlane.create(context.project.e2bTemplate || DEFAULT_E2B_TEMPLATE, credential, runTimeoutMs + 240_000,
        { app: "kangentix", owner: sandboxOwnerId(), projectId: context.project.id, runId: context.run.id }, signal);
      resource = { provider, id, expiresAt: new Date(Date.now() + runTimeoutMs + 240_000).toISOString() };
    } catch (error) {
      const pressure = (error instanceof E2BCreationRefusedError && [429, 503].includes(error.status)) || error instanceof RateLimitError || error instanceof ServiceBusyError;
      let confirmedAbsent = error instanceof E2BCreationRefusedError;
      if (!confirmedAbsent) {
        try {
          const owned = await discoverOwnedSandboxes(context.project.id, context.run.id, provider, credential);
          if (owned.length) {
            for (const candidate of owned) await disposeOwnedSandbox(candidate, credential);
            confirmedAbsent = true;
          }
        } catch (cleanupError) {
          await onLog(`E2B creation outcome remains uncertain; ownership cleanup is pending: ${cleanupError instanceof Error ? cleanupError.message : "provider unavailable"}.`);
        }
      }
      if (confirmedAbsent) await options.onDisposed?.();
      if (pressure && confirmedAbsent) {
        const pressure = new RetryablePreparationError("E2B rejected sandbox creation due to account capacity/throttling.", scope);
        recordProviderCooldown(pressure);
        throw pressure;
      }
      throw error;
    }
    try {
      await options.onCreated?.(resource);
      // Connecting must not extend the TTL beyond the ownership record.
      sandbox = await Sandbox.connect(resource.id, { apiKey: credential, requestTimeoutMs: 60_000, retries: 0, signal });
      await sandbox.commands.run(`mkdir -p ${ROOT}`, { user: "user", timeoutMs: 30_000, signal });
      const output = lineOutput(onLog, OUTPUT_LIMIT, secrets);
      await sandbox.commands.run("command -v claude >/dev/null || npm install --prefix /tmp/kangentix-cli @anthropic-ai/claude-code", { user: "user", timeoutMs: 180_000, signal, onStdout: (chunk) => output.write(chunk, "stdout"), onStderr: (chunk) => output.write(chunk, "stderr") });
      await output.flush();
    } catch (error) { await cleanupFailedProvision(resource, credential, options, onLog); throw error; }
    result = {
      resource,
      put: async (name, data) => { await sandbox.files.write(`${ROOT}/${validName(name)}`, typeof data === "string" ? data : Uint8Array.from(data).buffer, { user: "user", signal }); },
      putFile: async (name, path) => {
        const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
        // Stream uploads use the caller's signal directly in the installed SDK, so supply an explicit deadline.
        const transferSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
        try { await sandbox.files.write(`${ROOT}/${validName(name)}`, Readable.toWeb(stream) as ReadableStream, { user: "user", signal: transferSignal, requestTimeoutMs: 120_000, useOctetStream: true }); }
        finally { stream.destroy(); }
      },
      command: async (action, log) => {
        const output = lineOutput(log, OUTPUT_LIMIT, secrets);
        const command = await sandbox.commands.run(`PATH=/tmp/kangentix-cli/node_modules/.bin:$PATH python3 ${ROOT}/runner.py ${action}`, { user: "user", signal, timeoutMs: action === "run" ? runTimeoutMs : 120_000, onStdout: (chunk) => output.write(chunk, "stdout"), onStderr: (chunk) => output.write(chunk, "stderr") });
        await output.flush();
        if (command.exitCode !== 0) throw new Error(`Sandbox ${action} failed (${command.exitCode}).`);
      },
      read: async (name, maxBytes) => {
        const stream = await sandbox.files.read(`${ROOT}/${validName(name)}`, { user: "user", format: "stream", signal });
        const reader = stream.getReader();
        const chunks: Buffer[] = [];
        let total = 0;
        try {
          for (;;) {
            signal?.throwIfAborted();
            const next = await reader.read();
            if (next.done) break;
            total += next.value.byteLength;
            if (total > maxBytes) throw new Error("Sandbox output exceeded the transfer limit.");
            chunks.push(Buffer.from(next.value));
          }
        } finally { await reader.cancel().catch(() => { /* Already closed streams are harmless. */ }); }
        return Buffer.concat(chunks).toString("utf8");
      },
      cancel: () => disposeOwnedSandbox(resource!, credential),
      dispose: () => disposeOwnedSandbox(resource!, credential),
    };
  } else {
    const name = `kangentix-${sandboxOwnerId()}-${context.run.id.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 60)}`;
    const image = context.project.dockerImage || process.env.SANDBOX_DOCKER_IMAGE || "kangentix-sandbox:local";
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(image)) throw new Error("Set a valid Docker image name.");
    await onLog(`Starting fresh Docker sandbox from ${image}.`);
    await options.onCreating?.(provider, expiresAt);
    try {
      // Chromium's nested sandbox cannot use setuid/user namespaces under these
      // restrictions. Electron relies on the outer disposable Docker boundary.
      const created = await processCommand(["run", "-d", "--rm", "--name", name, "--label", "app=kangentix-sandbox", "--label", `kangentix.owner=${sandboxOwnerId()}`, "--label", `kangentix.project=${context.project.id}`, "--label", `kangentix.run=${context.run.id}`, "--label", `kangentix.expires=${expiresAt}`, "--user", "1000:1000", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=256", "--memory=4g", "--cpus=2", "--tmpfs", "/tmp:rw,exec,nosuid,size=2g,mode=1777", "--env", "HOME=/tmp/kangentix-home", "--env", "TMPDIR=/tmp", "--env", "ELECTRON_DISABLE_SANDBOX=1", "--workdir", "/tmp", "--entrypoint", "sleep", image, String(Math.ceil((runTimeoutMs + 240_000) / 1000))], 60_000, undefined, OUTPUT_LIMIT, undefined, true, signal, secrets);
      const id = created.trim();
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Docker returned an invalid sandbox container ID.");
      resource = { provider, id, expiresAt };
      await options.onCreated?.(resource);
      await processCommand(["exec", id, "mkdir", "-p", "-m", "700", ROOT, "/tmp/kangentix-home"], 60_000, undefined, OUTPUT_LIMIT, undefined, false, signal, secrets);
    } catch (error) {
      if (resource) await cleanupFailedProvision(resource, "", options, onLog);
      else if (error instanceof Error && /No such image|pull access denied|manifest (?:for .* )?not found|invalid reference format/i.test(error.message))
        await options.onDisposed?.();
      throw error;
    }
    const containerId = resource!.id;
    const put = async (filename: string, data: Buffer | string | Readable, size: number) => {
      const writer = ["import os, shutil, sys", "fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)", 'with os.fdopen(fd, "wb") as target:', "    shutil.copyfileobj(sys.stdin.buffer, target, 1024 * 1024)", "    written = target.tell()", "if written != int(sys.argv[2]):", '    raise RuntimeError("Incomplete sandbox file transfer")'].join("\n");
      await processCommand(["exec", "-i", containerId, "python3", "-c", writer, `${ROOT}/${validName(filename)}`, String(size)], 120_000, undefined, OUTPUT_LIMIT, data, false, signal, secrets);
    };
    result = {
      resource: resource!,
      put: (filename, data) => put(filename, data, Buffer.byteLength(data)),
      putFile: async (filename, path, size) => { const stream = createReadStream(path, { highWaterMark: 64 * 1024 }); try { await put(filename, stream, size); } finally { stream.destroy(); } },
      command: async (action, log) => { await processCommand(["exec", containerId, "python3", `${ROOT}/runner.py`, action], action === "run" ? runTimeoutMs : 120_000, log, OUTPUT_LIMIT, undefined, false, signal, secrets); },
      read: (filename, maxBytes) => processCommand(["exec", containerId, "cat", `${ROOT}/${validName(filename)}`], 30_000, undefined, maxBytes, undefined, true, signal, secrets),
      cancel: () => disposeOwnedSandbox(resource!),
      dispose: () => disposeOwnedSandbox(resource!),
    };
  }
  return result;
}

async function cleanupFailedProvision(resource: SandboxResource, credential: string, options: SandboxLifecycleOptions, onLog: (line: string) => Promise<void>) {
  try { await disposeOwnedSandbox(resource, credential); await options.onDisposed?.(); }
  catch (error) { await onLog(`Sandbox provisioning cleanup remains pending: ${error instanceof Error ? error.message : "unknown failure"}.`); }
}
export async function sandboxRunnerSource(): Promise<string> {
  return readFile(new URL("../../sandbox/runner.py", import.meta.url), "utf8").catch(() => readFile(join(process.cwd(), "sandbox/runner.py"), "utf8"));
}
