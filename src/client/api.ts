export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers:
      method === "GET" ? undefined : { "Content-Type": "application/json" },
    body: ["GET", "HEAD"].includes(method)
      ? undefined
      : JSON.stringify(body ?? {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      data?.error || `Request failed (${response.status}). Please try again.`,
      response.status,
    );
  return data as T;
}

export function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}

export function remembered(key: string, value?: string) {
  try {
    if (value !== undefined) localStorage.setItem(`kangentix.${key}`, value);
    return localStorage.getItem(`kangentix.${key}`) || "";
  } catch {
    return "";
  }
}

export function dateLabel(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
