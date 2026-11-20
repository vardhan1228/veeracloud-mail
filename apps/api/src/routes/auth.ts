import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { InvalidIdTokenError } from "@havins/auth";
import { C, type UserRecord, type Write } from "@havins/database";
import { sessionExchangeSchema } from "@havins/validation";
import { isAdmin, type AppEnv, type Config } from "../env";
import { AppError, parse } from "../errors";
import { currentUser, rateLimit } from "../middleware";
import { auditInsert, clientIp } from "../services/audit";
import { ADMIN_COOKIE, ADMIN_SESSION_TTL_MS, adminSession } from "../services/sessions";

/** ID tokens are only exchanged right after an interactive sign-in. */
const MAX_AUTH_AGE_SEC = 5 * 60;

/** Admin console sign-in (Firebase Authentication). Employees use /mail/login instead. */
export const authRoutes = new Hono<AppEnv>();

const presentUser = (config: Config, user: UserRecord) => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  emailVerified: user.emailVerified,
  role: isAdmin(config, user) ? ("admin" as const) : null,
});

authRoutes.post("/session", rateLimit("auth"), async (c) => {
  const { db, verifyIdToken, verifyTurnstile, now } = c.get("deps");
  const body = parse(sessionExchangeSchema, await c.req.json().catch(() => null));
  await verifyTurnstile(body.turnstileToken, clientIp(c));

  let identity;
  try {
    identity = await verifyIdToken(body.idToken);
  } catch (err) {
    if (err instanceof InvalidIdTokenError) {
      throw new AppError(401, "invalid_token", "Your sign-in could not be verified. Please sign in again.");
    }
    throw err;
  }
  const nowMs = now();
  if (Math.floor(nowMs / 1000) - identity.authTime > MAX_AUTH_AGE_SEC) {
    throw new AppError(401, "reauthentication_required", "Please sign in again.");
  }

  const existing = await db.get<UserRecord>(C.users, identity.uid);
  if (existing && existing.status !== "active")
    throw new AppError(403, "account_disabled", "This account has been disabled.");
  const user: UserRecord = {
    id: identity.uid,
    email: identity.email,
    emailVerified: identity.emailVerified,
    displayName: existing?.displayName ?? identity.name,
    status: existing?.status ?? "active",
    lastLoginAt: nowMs,
    createdAt: existing?.createdAt ?? nowMs,
  };
  c.set("user", user);

  const mfaVerified = identity.secondFactor !== null;
  const session = await adminSession({
    userId: user.id,
    mfaVerified,
    ttlMs: ADMIN_SESSION_TTL_MS,
    now: nowMs,
    ip: clientIp(c),
    userAgent: c.req.header("user-agent") ?? null,
  });
  const writes: Write[] = [
    { type: "set", collection: C.users, id: user.id, data: user },
    session.write,
    auditInsert(c, {
      action: "admin.signed_in",
      targetType: "user",
      targetId: user.id,
      metadata: { mfaVerified },
    }),
  ];
  await db.commit(writes);

  setCookie(c, ADMIN_COOKIE, session.token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(ADMIN_SESSION_TTL_MS / 1000),
  });
  return c.json({ user: presentUser(c.get("deps").config, user), mfaVerified });
});

authRoutes.post("/logout", async (c) => {
  const sessionId = c.get("sessionId");
  if (sessionId)
    await c.get("deps").db.commit([{ type: "delete", collection: C.adminSessions, id: sessionId }]);
  deleteCookie(c, ADMIN_COOKIE, { path: "/", secure: true });
  return c.json({ ok: true });
});

authRoutes.get("/me", (c) => {
  const user = currentUser(c);
  return c.json({ user: presentUser(c.get("deps").config, user), mfaVerified: c.get("mfaVerified") });
});
