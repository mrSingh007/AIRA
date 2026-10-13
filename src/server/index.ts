import "dotenv/config";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cookieParser from "cookie-parser";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { ZodError } from "zod";
import { api } from "./api.js";
import { acquireWorkerLock, closeDatabase, initializeDatabase } from "./db.js";
import { ApiError } from "./state.js";
import { initializeSecurity, protectOrigin } from "./security.js";
import { recoverInterruptedRuns, startWorker, stopWorker } from "./worker.js";

async function main() {
  initializeSecurity();
  const app = express();
  app.disable("x-powered-by");
  if (process.env.TRUST_PROXY === "true") app.set("trust proxy", 1);
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    next();
  });
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use("/api", protectOrigin);
  // Only ticket writes accept image payloads (five 2 MiB images plus base64 overhead).
  const ticketJson = express.json({ limit: "15mb" });
  const defaultJson = express.json({ limit: "1mb" });
  app.use((req, res, next) => {
    const ticketWrite =
      (req.method === "POST" &&
        /^\/api\/projects\/[^/]+\/tickets\/?$/.test(req.path)) ||
      (req.method === "PATCH" && /^\/api\/tickets\/[^/]+\/?$/.test(req.path));
    (ticketWrite ? ticketJson : defaultJson)(req, res, next);
  });
  app.use(cookieParser());
  app.use("/api", api);
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API endpoint not found." });
  });
  const clientDirectory = resolve(process.cwd(), "dist/client");
  if (existsSync(clientDirectory)) {
    app.use(express.static(clientDirectory, { index: false }));
    app.get("/{*path}", (req, res, next) => {
      if (req.accepts("html"))
        res.sendFile(resolve(clientDirectory, "index.html"));
      else next();
    });
  }
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (error instanceof ZodError)
        return res.status(400).json({
          error: error.issues
            .map((i) => `${i.path.join(".") || "Request"}: ${i.message}`)
            .join("; ")
            .slice(0, 2000),
        });
      if (error instanceof ApiError)
        return res.status(error.status).json({ error: error.message });
      if (error instanceof SyntaxError && "body" in error)
        return res
          .status(400)
          .json({ error: "Request body must be valid JSON." });
      if (
        typeof error === "object" &&
        error &&
        "type" in error &&
        error.type === "entity.too.large"
      )
        return res
          .status(413)
          .json({
            error:
              "The request is too large. Ticket images allow up to 5 files of 2 MiB each; other requests allow 1 MiB.",
          });
      // Never return raw database errors, stack traces, or connection strings.
      console.error("API request failed with an internal error.");
      return res
        .status(500)
        .json({
          error:
            "The server could not complete this request. Check the application and database logs.",
        });
    },
  );
  await initializeDatabase();
  const releaseWorkerLock = await acquireWorkerLock();
  await recoverInterruptedRuns();
  startWorker();
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, "0.0.0.0", () =>
    console.log(`AIRA listening on port ${port}.`),
  );
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const workerStopped = stopWorker();
    server.close(() => {
      void workerStopped
        .then(releaseWorkerLock)
        .then(closeDatabase)
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
    // Keep the worker lock/database alive through drain, cancellation and cleanup.
    // An emergency exit leaves durable ownership for startup reconciliation.
    setTimeout(() => {
      console.error("Shutdown emergency deadline reached; recovery will reconcile durable reservations.");
      process.exit(1);
    }, 90_000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
main().catch((error) => {
  console.error(
    error instanceof Error && /APP_SECRET|APP_URL|Another AIRA/.test(error.message)
      ? error.message
      : "AIRA could not start. Check DATABASE_URL, database connectivity, and application configuration.",
  );
  process.exit(1);
});
