import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { C, type MailboxRecord } from "@havins/database";
import type { OutgoingMessage } from "@havins/email-provider";
import {
  changeMailPasswordSchema,
  composeSchema,
  listMessagesSchema,
  mailLoginSchema,
  sendSchema,
  updateMessageSchema,
  type ComposeInput,
} from "@havins/validation";
import { z } from "zod";
import type { AppEnv } from "../env";
import { AppError, notFound, parse } from "../errors";
import { rateLimit, requireMail } from "../middleware";
import { audit, auditInsert, clientIp } from "../services/audit";
import {
  MAIL_COOKIE,
  MAIL_SESSION_TTL_MS,
  mailSession,
  mailSessionDeletes,
  sha256Hex,
} from "../services/sessions";

/** Live connections are recycled so no single request runs forever; EventSource reconnects. */
const EVENTS_MAX_MS = 5 * 60 * 1000;

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const opaqueId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);

export const mailRoutes = new Hono<AppEnv>();

const INVALID_LOGIN = () =>
  new AppError(401, "invalid_credentials", "Email address or password is incorrect.");

/** Employees sign in with their mailbox address and password; the mail server checks them. */
mailRoutes.post("/login", rateLimit("mail-login"), async (c) => {
  const { db, now, verifyTurnstile, emailProvider, sealCredential, rateLimit: limit } = c.get("deps");
  const input = parse(mailLoginSchema, await c.req.json().catch(() => null));
  await verifyTurnstile(input.turnstileToken, clientIp(c));
  if (!(await limit(`mail-login-address:${input.address}`))) {
    throw new AppError(
      429,
      "rate_limited",
      "Too many attempts for this mailbox. Wait a minute and try again.",
    );
  }

  const [mailbox] = await db.query<MailboxRecord>(C.mailboxes, {
    where: [["address", "==", input.address]],
    limit: 1,
  });
  const client =
    mailbox?.status === "active" ? await emailProvider().authenticate(mailbox.address, input.password) : null;
  if (!mailbox || !client) {
    await audit(c, {
      action: "mail.login_failed",
      targetType: "mailbox",
      targetId: mailbox?.id,
      metadata: { address: input.address },
    });
    throw INVALID_LOGIN();
  }

  const nowMs = now();
  const session = await mailSession({
    mailboxId: mailbox.id,
    credential: await sealCredential(input.password),
    ttlMs: MAIL_SESSION_TTL_MS,
    now: nowMs,
    ip: clientIp(c),
    userAgent: c.req.header("user-agent") ?? null,
  });
  c.set("mailbox", mailbox);
  await db.commit([
    session.write,
    { type: "update", collection: C.mailboxes, id: mailbox.id, data: { lastLoginAt: nowMs } },
    auditInsert(c, { action: "mail.signed_in", targetType: "mailbox", targetId: mailbox.id }),
  ]);
  setCookie(c, MAIL_COOKIE, session.token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(MAIL_SESSION_TTL_MS / 1000),
  });
  return c.json({ address: mailbox.address, displayName: mailbox.displayName });
});

mailRoutes.post("/logout", async (c) => {
  // Works even if the mail server is down: no JMAP connection needed to end a session.
  const token = getCookie(c, MAIL_COOKIE);
  if (token && /^[A-Za-z0-9_-]{20,100}$/.test(token)) {
    await c
      .get("deps")
      .db.commit([{ type: "delete", collection: C.mailSessions, id: await sha256Hex(token) }]);
  }
  deleteCookie(c, MAIL_COOKIE, { path: "/", secure: true });
  return c.json({ ok: true });
});

const authed = new Hono<AppEnv>();
authed.use("*", requireMail);

authed.get("/me", (c) => {
  const mailbox = c.get("mailbox")!;
  const provider = c.get("deps").emailProvider();
  return c.json({
    address: mailbox.address,
    displayName: mailbox.displayName,
    companyName: c.get("deps").config.companyName,
    developmentServer: provider.isMock,
  });
});

authed.get("/folders", async (c) => c.json({ folders: await c.get("mail").folders() }));

authed.get("/messages", async (c) => {
  const q = parse(listMessagesSchema, c.req.query());
  const result = await c
    .get("mail")
    .list({ folderId: q.folder, search: q.q, limit: q.limit, offset: q.offset });
  return c.json({ ...result, limit: q.limit, offset: q.offset });
});

function messageId(c: Context<AppEnv>, param = "id") {
  const parsed = opaqueId.safeParse(c.req.param(param));
  if (!parsed.success) throw notFound("Message");
  return parsed.data;
}

authed.get("/messages/:id", async (c) => {
  const msg = await c.get("mail").get(messageId(c));
  if (!msg) throw notFound("Message");
  return c.json({ message: msg });
});

authed.patch("/messages/:id", async (c) => {
  const id = messageId(c);
  const input = parse(updateMessageSchema, await c.req.json().catch(() => null));
  if (input.folder !== undefined && !opaqueId.safeParse(input.folder).success) throw notFound("Folder");
  await c.get("mail").update(id, { seen: input.seen, flagged: input.flagged, folderId: input.folder });
  return c.json({ ok: true });
});

/** Permanent delete. The UI only offers this from Trash and Junk. */
authed.delete("/messages/:id", async (c) => {
  await c.get("mail").destroy(messageId(c));
  return c.json({ ok: true });
});

async function outgoing(c: Context<AppEnv>, input: ComposeInput): Promise<OutgoingMessage> {
  const mailbox = c.get("mailbox")!;
  let inReplyTo: OutgoingMessage["inReplyTo"];
  if (input.inReplyToId) {
    const original = await c.get("mail").get(input.inReplyToId);
    if (original) inReplyTo = { messageId: original.messageId, references: original.references };
  }
  return {
    from: { name: mailbox.displayName, email: mailbox.address },
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    text: input.text,
    attachments: input.attachments,
    inReplyTo,
  };
}

authed.post(
  "/send",
  rateLimit("mail-send", (c) => c.get("mailbox")?.id),
  async (c) => {
    const input = parse(sendSchema, await c.req.json().catch(() => null));
    const result = await c.get("mail").send(await outgoing(c, input), input.draftId);
    await audit(c, {
      action: "mail.sent",
      targetType: "mailbox",
      targetId: c.get("mailbox")!.id,
      metadata: {
        recipients: input.to.length + input.cc.length + input.bcc.length,
        attachments: input.attachments.length,
      },
    });
    return c.json(result);
  },
);

authed.post("/drafts", async (c) => {
  const input = parse(composeSchema, await c.req.json().catch(() => null));
  return c.json(await c.get("mail").saveDraft(await outgoing(c, input), input.draftId));
});

authed.post("/attachments", async (c) => {
  const length = Number(c.req.header("content-length") ?? "0");
  if (length > MAX_UPLOAD_BYTES) throw new AppError(413, "too_large", "Attachments can be at most 25 MB");
  const data = await c.req.arrayBuffer();
  if (data.byteLength === 0) throw new AppError(400, "empty_file", "The file is empty");
  if (data.byteLength > MAX_UPLOAD_BYTES)
    throw new AppError(413, "too_large", "Attachments can be at most 25 MB");
  const type = (c.req.header("content-type") ?? "application/octet-stream").split(";")[0]!.slice(0, 255);
  const name =
    decodeURIComponent(c.req.header("x-filename") ?? "attachment")
      .replace(/[\\/\r\n"]/g, "_")
      .slice(0, 255) || "attachment";
  const { blobId, size } = await c.get("mail").upload(data, type);
  return c.json({ blobId, name, type, size }, 201);
});

/** Always served as a download with a sandboxing CSP, never rendered inline. */
authed.get("/attachments/:blobId", async (c) => {
  const blobId = messageId(c, "blobId");
  const name =
    (c.req.query("name") ?? "attachment").replace(/[^\w.\- ()]/g, "_").slice(0, 200) || "attachment";
  const file = await c.get("mail").download(blobId);
  if (!file) throw notFound("Attachment");
  return new Response(file.body as ConstructorParameters<typeof Response>[0], {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store",
    },
  });
});

/** Recipients for autocomplete: colleagues from the company directory plus past correspondents. */
authed.get("/contacts", async (c) => {
  const q = (c.req.query("q") ?? "").trim().toLowerCase().slice(0, 100);
  const self = c.get("mailbox")!;
  const colleagues = (
    await c.get("deps").db.query<MailboxRecord>(C.mailboxes, { where: [["status", "==", "active"]] })
  )
    .filter(
      (m) => m.id !== self.id && (!q || m.address.includes(q) || m.displayName.toLowerCase().includes(q)),
    )
    .slice(0, 8)
    .map((m) => ({ name: m.displayName, email: m.address }));
  const past = await c.get("mail").contacts(q, 8);
  const merged = new Map<string, { name: string | null; email: string }>();
  for (const x of [...colleagues, ...past]) if (!merged.has(x.email)) merged.set(x.email, x);
  return c.json({ contacts: [...merged.values()].slice(0, 10) });
});

authed.post(
  "/password",
  rateLimit("mail-password", (c) => c.get("mailbox")?.id),
  async (c) => {
    const { db, emailProvider, sealCredential } = c.get("deps");
    const mailbox = c.get("mailbox")!;
    const input = parse(changeMailPasswordSchema, await c.req.json().catch(() => null));
    const provider = emailProvider();
    if (!(await provider.authenticate(mailbox.address, input.currentPassword))) {
      throw new AppError(400, "wrong_password", "Your current password is incorrect");
    }
    if (!mailbox.providerMailboxId) throw new AppError(409, "mailbox_not_ready", "Mailbox is not set up");
    await provider.admin.updateMailbox(mailbox.providerMailboxId, { password: input.newPassword });
    const current = c.get("mailSessionId")!;
    // Keep this session (with the new password); sign out every other device.
    await db.commit([
      {
        type: "update",
        collection: C.mailSessions,
        id: current,
        data: { credential: await sealCredential(input.newPassword) },
      },
      ...(await mailSessionDeletes(db, mailbox.id, current)),
      auditInsert(c, { action: "mail.password_changed", targetType: "mailbox", targetId: mailbox.id }),
    ]);
    return c.json({ ok: true });
  },
);

/**
 * Server-sent events: "change" whenever new mail arrives or the mailbox changes (pushed by the
 * mail server over JMAP), with keep-alive pings. The browser refreshes what it shows.
 */
authed.get("/events", (c) => {
  const mail = c.get("mail");
  return streamSSE(c, async (stream) => {
    const ctrl = new AbortController();
    stream.onAbort(() => ctrl.abort());
    const timer = setTimeout(() => ctrl.abort(), EVENTS_MAX_MS);
    try {
      await stream.writeSSE({ event: "ready", data: "{}", retry: 3000 });
      for await (const e of mail.watch(ctrl.signal)) {
        if (e === "change") await stream.writeSSE({ event: "change", data: "{}" });
        else await stream.write(": ping\n\n");
      }
    } catch (err) {
      if (!ctrl.signal.aborted)
        await stream
          .writeSSE({ event: "unavailable", data: JSON.stringify({ message: (err as Error).message }) })
          .catch(() => undefined);
    } finally {
      clearTimeout(timer);
      ctrl.abort();
    }
  });
});

mailRoutes.route("/", authed);
