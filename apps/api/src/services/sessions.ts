import {
  C,
  type AdminSessionRecord,
  type MailSessionRecord,
  type MailboxRecord,
  type Store,
  type UserRecord,
  type Write,
} from "@havins/database";

export const ADMIN_COOKIE = "__Host-admin";
export const MAIL_COOKIE = "__Host-mail";
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const MAIL_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface Common {
  ttlMs: number;
  now: number;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Builds a session. The cookie gets the random token; the document id is its SHA-256, so a
 * database leak does not reveal usable cookies. The write is returned so callers commit it
 * together with related changes and the audit entry.
 */
export async function adminSession(input: Common & { userId: string; mfaVerified: boolean }) {
  const token = randomToken();
  const id = await sha256Hex(token);
  const data: AdminSessionRecord = {
    id,
    userId: input.userId,
    mfaVerified: input.mfaVerified,
    expiresAt: input.now + input.ttlMs,
    ip: input.ip,
    userAgent: input.userAgent?.slice(0, 300) ?? null,
    createdAt: input.now,
  };
  return { token, sessionId: id, write: { type: "create", collection: C.adminSessions, id, data } as Write };
}

export async function mailSession(input: Common & { mailboxId: string; credential: string }) {
  const token = randomToken();
  const id = await sha256Hex(token);
  const data: MailSessionRecord = {
    id,
    mailboxId: input.mailboxId,
    credential: input.credential,
    expiresAt: input.now + input.ttlMs,
    ip: input.ip,
    userAgent: input.userAgent?.slice(0, 300) ?? null,
    createdAt: input.now,
  };
  return { token, sessionId: id, write: { type: "create", collection: C.mailSessions, id, data } as Write };
}

function plausible(token: string) {
  return /^[A-Za-z0-9_-]{20,100}$/.test(token);
}

async function load<T extends { expiresAt: number }>(
  db: Store,
  collection: string,
  token: string,
  now: number,
) {
  if (!plausible(token)) return null;
  const id = await sha256Hex(token);
  const s = await db.get<T>(collection, id);
  if (!s) return null;
  if (s.expiresAt <= now) {
    await db.commit([{ type: "delete", collection, id }]).catch(() => undefined);
    return null;
  }
  return s;
}

export async function resolveAdminSession(db: Store, token: string, now: number) {
  const s = await load<AdminSessionRecord>(db, C.adminSessions, token, now);
  if (!s) return null;
  const user = await db.get<UserRecord>(C.users, s.userId);
  if (!user || user.status !== "active") return null;
  return { sessionId: s.id, mfaVerified: s.mfaVerified, user };
}

export async function resolveMailSession(db: Store, token: string, now: number) {
  const s = await load<MailSessionRecord>(db, C.mailSessions, token, now);
  if (!s) return null;
  const mailbox = await db.get<MailboxRecord>(C.mailboxes, s.mailboxId);
  // A disabled mailbox loses webmail access immediately, even with a live session.
  if (!mailbox || mailbox.status !== "active") return null;
  return { sessionId: s.id, credential: s.credential, mailbox };
}

/** Deletes for every webmail session of a mailbox (optionally keeping one). */
export async function mailSessionDeletes(db: Store, mailboxId: string, keep?: string): Promise<Write[]> {
  const rows = await db.query<MailSessionRecord>(C.mailSessions, { where: [["mailboxId", "==", mailboxId]] });
  return rows
    .filter((r) => r.id !== keep)
    .map((r) => ({ type: "delete", collection: C.mailSessions, id: r.id }));
}

/** Removes expired sessions. Run from the daily cron trigger. */
export async function purgeExpiredSessions(db: Store, now: number): Promise<number> {
  let removed = 0;
  for (const collection of [C.adminSessions, C.mailSessions]) {
    const rows = await db.query<{ id: string }>(collection, { where: [["expiresAt", "<", now]], limit: 450 });
    if (rows.length) await db.commit(rows.map((r) => ({ type: "delete", collection, id: r.id })));
    removed += rows.length;
  }
  return removed;
}
