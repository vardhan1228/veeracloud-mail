import { Hono } from "hono";
import { StoreUnavailableError, WriteConflictError } from "@havins/database";
import { ProviderNotConfiguredError, ProviderRequestError } from "@havins/email-provider";
import type { AppEnv, Bindings, Deps } from "./env";
import { AppError } from "./errors";
import { cors, csrf, requireUser, securityHeaders, sessionLoader } from "./middleware";
import { authRoutes } from "./routes/auth";
import { adminRoutes } from "./routes/admin";
import { mailRoutes } from "./routes/mail";

/** `getDeps` is called per request; production caches per isolate, tests inject fakes. */
export function createApp(getDeps: (env: Bindings) => Deps) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const deps = getDeps(c.env);
    c.set("deps", deps);
    if (deps.ready) await deps.ready;
    await next();
  });
  app.use("*", securityHeaders, cors, csrf, sessionLoader);

  app.get("/health", (c) => c.json({ ok: true, environment: c.get("deps").config.environment }));
  app.use("/auth/me", requireUser);
  app.route("/auth", authRoutes);
  app.use("/admin/*", requireUser);
  app.route("/admin", adminRoutes);
  app.route("/mail", mailRoutes);

  app.notFound((c) => c.json({ code: "not_found", message: "Not found" }, 404));

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ code: err.code, message: err.message, details: err.details }, err.status);
    }
    if (err instanceof ProviderNotConfiguredError) {
      return c.json(
        {
          code: "provider_not_configured",
          message: "The mail server is not connected yet. Ask your administrator.",
        },
        503,
      );
    }
    if (err instanceof ProviderRequestError) {
      return c.json(
        { code: "provider_error", message: err.message, retryable: err.retryable },
        err.retryable ? 503 : 502,
      );
    }
    if (err instanceof WriteConflictError) {
      return c.json(
        { code: "conflict", message: "Someone else changed this at the same time. Reload and try again." },
        409,
      );
    }
    if (err instanceof StoreUnavailableError) {
      console.error("Database unavailable", err.message);
      return c.json(
        {
          code: "database_unavailable",
          message: "The database is not reachable right now. Try again shortly.",
        },
        503,
      );
    }
    console.error("Unhandled error", err);
    return c.json({ code: "internal_error", message: "Something went wrong. Please try again." }, 500);
  });

  return app;
}
