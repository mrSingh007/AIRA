import {
  createHash,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { ApiError, assert, type State, type StoredUser } from "./state.js";

const cookieName = "aira_session";
const maxAge = 7 * 24 * 60 * 60 * 1000;
let encryptionKey: Buffer;
let allowedOrigin: string;
export function initializeSecurity() {
  const secret = process.env.APP_SECRET || "";
  if (secret.length < 32 || /^replace[-_ ]|^change[-_ ]?me/i.test(secret))
    throw new Error(
      "APP_SECRET must be set to a random secret of at least 32 characters.",
    );
  try {
    const url = new URL(process.env.APP_URL || "");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid origin");
    allowedOrigin = url.origin;
  } catch {
    throw new Error(
      "APP_URL must be set to the HTTP or HTTPS origin used to open AIRA, without credentials, a path, query, or fragment.",
    );
  }
  encryptionKey = createHash("sha256").update(secret).digest();
}
export function encrypt(value: string): string {
  if (!value) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${ciphertext.toString("base64")}`;
}
export function decrypt(value: string): string {
  if (!value) return "";
  const [iv, tag, content] = value
    .split(".")
    .map((s) => Buffer.from(s, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(content), decipher.final()]).toString(
    "utf8",
  );
}
export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
function secureCookie(req: Request): boolean {
  return (
    process.env.COOKIE_SECURE === "true" ||
    allowedOrigin.startsWith("https://") ||
    req.secure
  );
}
export function issueSession(
  state: State,
  req: Request,
  res: Response,
  userId: string,
) {
  const token = randomBytes(32).toString("hex");
  state.sessions = state.sessions.filter(
    (s) => s.expiresAt > new Date().toISOString(),
  );
  const previous = state.sessions.filter((s) => s.userId === userId).slice(-9);
  state.sessions = state.sessions
    .filter((s) => s.userId !== userId)
    .concat(previous);
  state.sessions.push({
    tokenHash: hashToken(token),
    userId,
    expiresAt: new Date(Date.now() + maxAge).toISOString(),
  });
  res.cookie(cookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookie(req),
    path: "/",
    maxAge,
  });
}
export function clearSession(state: State, req: Request, res: Response) {
  const token = req.cookies?.[cookieName];
  if (typeof token === "string")
    state.sessions = state.sessions.filter(
      (s) => s.tokenHash !== hashToken(token),
    );
  res.clearCookie(cookieName, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookie(req),
    path: "/",
  });
}
export function authenticate(
  state: State,
  req: Request,
  allowPasswordChange = false,
): StoredUser {
  const token = req.cookies?.[cookieName];
  assert(
    typeof token === "string" && token.length === 64,
    401,
    "Please sign in.",
  );
  const session = state.sessions.find(
    (s) =>
      s.tokenHash === hashToken(token) &&
      s.expiresAt > new Date().toISOString(),
  );
  const user = session && state.users.find((u) => u.id === session.userId);
  assert(user, 401, "Your session has expired. Please sign in.");
  assert(
    allowPasswordChange || !user.mustChangePassword,
    403,
    "Change your initial password before using AIRA.",
  );
  return user;
}
export function protectOrigin(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (!req.is("application/json"))
    return next(new ApiError(415, "API writes require application/json."));
  const origin = req.get("origin");
  if (origin && origin !== allowedOrigin)
    return next(new ApiError(403, "Cross-origin requests are not allowed."));
  if (req.get("sec-fetch-site") === "cross-site")
    return next(new ApiError(403, "Cross-site requests are not allowed."));
  next();
}
export function redact(value: string, secrets: string[] = []): string {
  let safe = value;
  for (const secret of secrets.filter((s) => s.length > 0))
    safe = safe.split(secret).join("[REDACTED]");
  return safe
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g,
      "[REDACTED]",
    )
    .replace(
      /(authorization\s*[:=]\s*(?:bearer|token)\s+)[^\s"']+/gi,
      "$1[REDACTED]",
    );
}
