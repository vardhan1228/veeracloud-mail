import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { C } from "@havins/database";
import { isAdmin, type AppEnv } from "./env";
import { AppError, forbidden, unauthorized } from "./errors";
import { ADMIN_COOKIE, MAIL_COOKIE, resolveAdminSession, resolveMailSession } from "./services/sessions";
import { clientIp } from "./services/audit";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** API responses are JSON (or attachment downloads), so the CSP can deny everything. */
export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
  c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; sandbox");
  c.header("Cross-Origin-Resource-Policy", "same-site");
  c.header("Cache-Control", "no-store");
};

/** Exact-match CORS allowlist with credentials. */
export const cors: MiddlewareHandler<AppEnv> = async (c, next) => {
  const origin = c.req.header("origin");
  const allowed = origin !== undefined && c.get("deps").config.appOrigins.includes(origin);
  if (c.req.method === "OPTIONS") {
    if (!allowed) return c.body(null, 403);
    return c.body(null, 204, {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE",
      "Access-Control-Allow-Headers": "content-type, x-filename, last-event-id",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    });
  }
  await next();
  if (allowed) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Access-Control-Allow-Credentials", "true");
  }
  c.header("Vary", "Origin", { append: true });
};

/** State-changing requests must come from an allowlisted origin (SameSite=Lax is the second layer). */
export const csrf: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method)) {
    const origin = c.req.header("origin");
    if (!origin || !c.get("deps").config.appOrigins.includes(origin)) {
      throw new AppError(403, "csrf_rejected", "Request origin is not allowed");
    }
  }
  await next();
};

/** Loads whichever sessions are present. Never rejects on its own. */
export const sessionLoader: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("user", null);
  c.set("sessionId", null);
  c.set("mfaVerified", false);
  c.set("mailbox", null);
  c.set("mailSessionId", null);
  const { db, now } = c.get("deps");
  const adminToken = getCookie(c, ADMIN_COOKIE);
  if (adminToken) {
    const s = await resolveAdminSession(db, adminToken, now());
    if (s) {
      c.set("user", s.user);
      c.set("sessionId", s.sessionId);
      c.set("mfaVerified", s.mfaVerified);
    }
  }
  await next();
};

export function currentUser(c: Context<AppEnv>) {
  const user = c.get("user");
  if (!user) throw unauthorized();
  return user;
}

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  currentUser(c);
  await next();
};

/** Admin console: signed-in Firebase user with role=admin and a second factor on this session. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = currentUser(c);
  if (!isAdmin(c.get("deps").config, user)) throw forbidden("This account is not an administrator");
  if (!c.get("mfaVerified") && !c.get("deps").config.devAllowAdminWithoutMfa) {
    throw new AppError(403, "mfa_required", "Sign in again with your second factor to use the admin console");
  }
  await next();
};

/**
 * Webmail: resolves the mail session cookie, decrypts the mailbox password and opens a JMAP
 * connection as that employee. The mail server itself enforces which messages they can see.
 */
export const requireMail: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, MAIL_COOKIE);
  const { db, now, openCredential, emailProvider } = c.get("deps");
  const s = token ? await resolveMailSession(db, token, now()) : null;
  if (!s) throw new AppError(401, "unauthenticated", "Sign in to your mailbox to continue");
  const deleteSession = () => db.commit([{ type: "delete", collection: C.mailSessions, id: s.sessionId }]);
  let password: string;
  try {
    password = await openCredential(s.credential);
  } catch {
    await deleteSession();
    throw new AppError(401, "unauthenticated", "Your session has expired. Sign in again.");
  }
  const client = await emailProvider().authenticate(s.mailbox.address, password);
  if (!client) {
    // Password changed or account disabled on the mail server.
    await deleteSession();
    throw new AppError(401, "unauthenticated", "Your password has changed. Sign in again.");
  }
  c.set("mailbox", s.mailbox);
  c.set("mailSessionId", s.sessionId);
  c.set("mail", client);
  await next();
};

export function rateLimit(
  bucket: string,
  keyFn?: (c: Context<AppEnv>) => string | undefined,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = `${bucket}:${keyFn?.(c) ?? c.get("user")?.id ?? clientIp(c) ?? "unknown"}`;
    if (!(await c.get("deps").rateLimit(key))) {
      throw new AppError(429, "rate_limited", "Too many attempts. Wait a minute and try again.");
    }
    await next();
  };
}
