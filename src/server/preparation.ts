import { createHash } from "node:crypto";

type Waiter = { resolve: (release: () => void) => void; reject: (error: unknown) => void; signal?: AbortSignal; abort?: () => void };

/** A bounded transfer queue, round-robin between projects (independent of execution slots). */
export class FairPreparationGate {
  private active = 0;
  private queues = new Map<string, Waiter[]>();
  private order: string[] = [];
  constructor(readonly capacity = 4) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Invalid preparation capacity.");
  }
  acquire(projectId: string, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      waiter.abort = () => {
        const queue = this.queues.get(projectId);
        const index = queue?.indexOf(waiter) ?? -1;
        if (queue && index >= 0) queue.splice(index, 1);
        if (!queue?.length) {
          this.queues.delete(projectId);
          this.order = this.order.filter((id) => id !== projectId);
        }
        signal?.removeEventListener("abort", waiter.abort!);
        reject(signal?.reason ?? new Error("Preparation cancelled."));
      };
      signal?.addEventListener("abort", waiter.abort, { once: true });
      let queue = this.queues.get(projectId);
      if (!queue) { queue = []; this.queues.set(projectId, queue); this.order.push(projectId); }
      queue.push(waiter);
      this.pump();
    });
  }
  private pump() {
    while (this.active < this.capacity && this.order.length) {
      const projectId = this.order.shift()!;
      const queue = this.queues.get(projectId)!;
      const waiter = queue.shift()!;
      if (queue.length) this.order.push(projectId);
      else this.queues.delete(projectId);
      waiter.signal?.removeEventListener("abort", waiter.abort!);
      this.active++;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        this.pump();
      });
    }
  }
  get occupancy() { return this.active; }
  get waiting() { return [...this.queues.values()].reduce((count, queue) => count + queue.length, 0); }
}

export const preparationGate = new FairPreparationGate(4);
export const credentialScope = (provider: string, credential: string) =>
  `${provider}:${createHash("sha256").update(credential).digest("hex")}`;

/** Only explicit pre-agent throttling is eligible for delayed queue retry. */
export class RetryablePreparationError extends Error {
  constructor(message: string, readonly scope: string, readonly retryAfterMs = 30_000) {
    super(message); this.name = "RetryablePreparationError";
  }
}

const cooldowns = new Map<string, number>();
export function providerCooldown(scope: string): number {
  const remaining = (cooldowns.get(scope) ?? 0) - Date.now();
  if (remaining <= 0) { cooldowns.delete(scope); return 0; }
  return remaining;
}
export function recordProviderCooldown(error: RetryablePreparationError) {
  cooldowns.set(error.scope, Math.max(cooldowns.get(error.scope) ?? 0, Date.now() + error.retryAfterMs));
}

export function retryDelay(attempt: number, minimumMs = 0, random = Math.random): number {
  return Math.min(300_000, Math.max(minimumMs, 5_000 * 2 ** Math.min(attempt, 6)) + Math.floor(random() * 2_000));
}

export function throttledResponse(response: Response, scope: string): RetryablePreparationError | undefined {
  if (response.status !== 429 && !(response.status === 403 && (response.headers.has("retry-after") || response.headers.get("x-ratelimit-remaining") === "0"))) return;
  const retry = response.headers.get("retry-after");
  const delay = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : Number(response.headers.get("x-ratelimit-reset") || 0) * 1000 - Date.now();
  const error = new RetryablePreparationError("GitHub throttled this credential scope; waiting before preparation/publication.", scope, Math.max(1_000, Number.isFinite(delay) && delay > 0 ? delay : 30_000));
  recordProviderCooldown(error);
  return error;
}

export async function abortableDelay(ms: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const done = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason ?? new Error("Cancelled.")); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
