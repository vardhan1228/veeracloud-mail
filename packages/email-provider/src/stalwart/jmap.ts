import { collectContacts } from "../mock";
import {
  ProviderRequestError,
  type Attachment,
  type EmailAddress,
  type Folder,
  type FolderRole,
  type MailClient,
  type MailEvent,
  type Message,
  type MessageSummary,
  type OutgoingMessage,
  type SendResult,
} from "../types";
import { parseSse } from "../sse";
import { basicAuth } from "./admin";

/** JMAP for Mail (RFC 8620 core, RFC 8621 mail/submission), as served by Stalwart. */

const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"];
const ROLES = new Set<FolderRole>(["inbox", "sent", "drafts", "junk", "trash", "archive"]);

interface JmapSession {
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  /** RFC 8620 §7.3 push: `{types}`, `{closeafter}`, `{ping}` placeholders. */
  eventSourceUrl?: string;
  primaryAccounts: Record<string, string>;
}

type Invocation = [string, Record<string, unknown>, string];

interface JmapEmail {
  id: string;
  mailboxIds: Record<string, boolean>;
  keywords?: Record<string, boolean>;
  from?: EmailAddress[] | null;
  to?: EmailAddress[] | null;
  cc?: EmailAddress[] | null;
  replyTo?: EmailAddress[] | null;
  subject?: string | null;
  preview?: string;
  receivedAt: string;
  hasAttachment?: boolean;
  messageId?: string[] | null;
  references?: string[] | null;
  bodyValues?: Record<string, { value: string }>;
  textBody?: { partId: string; type: string }[];
  htmlBody?: { partId: string; type: string }[];
  attachments?: { blobId: string; name: string | null; type: string; size: number }[];
}

const SUMMARY_PROPS = [
  "id",
  "mailboxIds",
  "keywords",
  "from",
  "to",
  "subject",
  "preview",
  "receivedAt",
  "hasAttachment",
];

function toSummary(e: JmapEmail): MessageSummary {
  return {
    id: e.id,
    folderIds: Object.keys(e.mailboxIds ?? {}),
    from: e.from ?? [],
    to: e.to ?? [],
    subject: e.subject ?? "",
    preview: e.preview ?? "",
    receivedAt: Date.parse(e.receivedAt),
    seen: e.keywords?.$seen === true,
    flagged: e.keywords?.$flagged === true,
    hasAttachment: e.hasAttachment === true,
  };
}

export class JmapClient implements MailClient {
  private folderCache: Folder[] | null = null;

  private constructor(
    readonly address: string,
    private readonly session: JmapSession,
    private readonly accountId: string,
    private readonly auth: string,
    private readonly fetcher: typeof fetch,
  ) {}

  /** Fetches the JMAP session with the user's credentials. Null when the server rejects them. */
  static async connect(baseUrl: string, address: string, password: string, fetcher: typeof fetch = fetch) {
    const auth = basicAuth(address, password);
    let res: Response;
    try {
      res = await fetcher(`${baseUrl.replace(/\/+$/, "")}/.well-known/jmap`, {
        headers: { authorization: auth },
      });
    } catch {
      throw new ProviderRequestError("Mail server is unreachable", true);
    }
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) throw new ProviderRequestError(`Mail server error (HTTP ${res.status})`, res.status >= 500);
    const session = (await res.json()) as JmapSession;
    const accountId = session.primaryAccounts["urn:ietf:params:jmap:mail"];
    if (!accountId) throw new ProviderRequestError("Mail server did not offer a mail account", false);
    return new JmapClient(address, session, accountId, auth, fetcher);
  }

  private async call(calls: Invocation[]): Promise<Invocation[]> {
    let res: Response;
    try {
      res = await this.fetcher(this.session.apiUrl, {
        method: "POST",
        headers: { authorization: this.auth, "content-type": "application/json" },
        body: JSON.stringify({ using: USING, methodCalls: calls }),
      });
    } catch {
      throw new ProviderRequestError("Mail server is unreachable", true);
    }
    if (!res.ok) throw new ProviderRequestError(`Mail server error (HTTP ${res.status})`, res.status >= 500);
    const body = (await res.json()) as { methodResponses: Invocation[] };
    for (const [name, args] of body.methodResponses) {
      if (name === "error") throw new ProviderRequestError(`Mail server error: ${String(args.type)}`, false);
    }
    return body.methodResponses;
  }

  private result(responses: Invocation[], callId: string): Record<string, unknown> {
    const found = responses.find((r) => r[2] === callId);
    if (!found) throw new ProviderRequestError("Malformed mail server response", false);
    return found[1];
  }

  async folders(): Promise<Folder[]> {
    const r = await this.call([
      [
        "Mailbox/get",
        {
          accountId: this.accountId,
          ids: null,
          properties: ["id", "name", "role", "totalEmails", "unreadEmails", "sortOrder"],
        },
        "m",
      ],
    ]);
    const list = (
      this.result(r, "m").list as {
        id: string;
        name: string;
        role: string | null;
        totalEmails: number;
        unreadEmails: number;
        sortOrder: number;
      }[]
    ).sort((a, b) => a.sortOrder - b.sortOrder);
    this.folderCache = list.map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role && ROLES.has(m.role as FolderRole) ? (m.role as FolderRole) : null,
      total: m.totalEmails,
      unread: m.unreadEmails,
    }));
    return this.folderCache;
  }

  private async folderId(role: FolderRole): Promise<string> {
    const folders = this.folderCache ?? (await this.folders());
    const f = folders.find((x) => x.role === role);
    if (!f) throw new ProviderRequestError(`The mailbox has no ${role} folder`, false);
    return f.id;
  }

  /** `folderId` may be a role name ("inbox") or a JMAP mailbox id. */
  private async resolveFolder(folderId: string): Promise<string> {
    return ROLES.has(folderId as FolderRole) ? this.folderId(folderId as FolderRole) : folderId;
  }

  async list(opts: { folderId: string; search?: string; limit: number; offset: number }) {
    const filter: Record<string, unknown> = { inMailbox: await this.resolveFolder(opts.folderId) };
    if (opts.search) filter.text = opts.search;
    const r = await this.call([
      [
        "Email/query",
        {
          accountId: this.accountId,
          filter,
          sort: [{ property: "receivedAt", isAscending: false }],
          position: opts.offset,
          limit: opts.limit,
          calculateTotal: true,
        },
        "q",
      ],
      [
        "Email/get",
        {
          accountId: this.accountId,
          "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
          properties: SUMMARY_PROPS,
        },
        "g",
      ],
    ]);
    return {
      total: (this.result(r, "q").total as number) ?? 0,
      messages: (this.result(r, "g").list as JmapEmail[]).map(toSummary),
    };
  }

  async get(id: string): Promise<Message | null> {
    const r = await this.call([
      [
        "Email/get",
        {
          accountId: this.accountId,
          ids: [id],
          properties: [
            ...SUMMARY_PROPS,
            "cc",
            "replyTo",
            "messageId",
            "references",
            "bodyValues",
            "textBody",
            "htmlBody",
            "attachments",
          ],
          fetchTextBodyValues: true,
          fetchHTMLBodyValues: true,
          maxBodyValueBytes: 2_000_000,
        },
        "g",
      ],
    ]);
    const e = (this.result(r, "g").list as JmapEmail[])[0];
    if (!e) return null;
    const values = e.bodyValues ?? {};
    const join = (parts: { partId: string; type: string }[] | undefined, type: string) => {
      const chosen = (parts ?? []).filter((p) => p.type === type && values[p.partId]);
      return chosen.length > 0 ? chosen.map((p) => values[p.partId]!.value).join("\n") : null;
    };
    return {
      ...toSummary(e),
      cc: e.cc ?? [],
      replyTo: e.replyTo ?? [],
      messageId: e.messageId?.[0] ?? null,
      references: e.references ?? [],
      text: join(e.textBody, "text/plain"),
      html: join(e.htmlBody, "text/html"),
      attachments: (e.attachments ?? []).map((a) => ({
        blobId: a.blobId,
        name: a.name ?? "attachment",
        type: a.type,
        size: a.size,
      })),
    };
  }

  async update(id: string, changes: { seen?: boolean; flagged?: boolean; folderId?: string }): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (changes.seen !== undefined) patch["keywords/$seen"] = changes.seen ? true : null;
    if (changes.flagged !== undefined) patch["keywords/$flagged"] = changes.flagged ? true : null;
    if (changes.folderId !== undefined)
      patch.mailboxIds = { [await this.resolveFolder(changes.folderId)]: true };
    const r = await this.call([["Email/set", { accountId: this.accountId, update: { [id]: patch } }, "s"]]);
    const notUpdated = this.result(r, "s").notUpdated as Record<string, { type: string }> | null;
    if (notUpdated?.[id])
      throw new ProviderRequestError(`Could not update message: ${notUpdated[id].type}`, false);
  }

  async destroy(id: string): Promise<void> {
    await this.call([["Email/set", { accountId: this.accountId, destroy: [id] }, "d"]]);
  }

  private async draftObject(msg: OutgoingMessage, draftsId: string) {
    return {
      mailboxIds: { [draftsId]: true },
      keywords: { $draft: true, $seen: true },
      from: [msg.from],
      to: msg.to.map((email) => ({ email })),
      cc: msg.cc.map((email) => ({ email })),
      bcc: msg.bcc.map((email) => ({ email })),
      subject: msg.subject,
      ...(msg.inReplyTo?.messageId
        ? {
            inReplyTo: [msg.inReplyTo.messageId],
            references: [...msg.inReplyTo.references, msg.inReplyTo.messageId],
          }
        : {}),
      bodyValues: { body: { value: msg.text } },
      textBody: [{ partId: "body", type: "text/plain" }],
      attachments: msg.attachments.map((a) => ({
        blobId: a.blobId,
        type: a.type,
        name: a.name,
        disposition: "attachment",
      })),
    };
  }

  async saveDraft(msg: OutgoingMessage, replaceDraftId?: string): Promise<{ id: string }> {
    const draftsId = await this.folderId("drafts");
    const r = await this.call([
      [
        "Email/set",
        {
          accountId: this.accountId,
          create: { draft: await this.draftObject(msg, draftsId) },
          ...(replaceDraftId ? { destroy: [replaceDraftId] } : {}),
        },
        "s",
      ],
    ]);
    const created = (this.result(r, "s").created as Record<string, { id: string }> | null)?.draft;
    if (!created) throw new ProviderRequestError("The mail server did not save the draft", false);
    return { id: created.id };
  }

  async send(msg: OutgoingMessage, replaceDraftId?: string): Promise<SendResult> {
    const [draftsId, sentId] = await Promise.all([this.folderId("drafts"), this.folderId("sent")]);
    const ids = await this.call([["Identity/get", { accountId: this.accountId, ids: null }, "i"]]);
    const identities = this.result(ids, "i").list as { id: string; email: string }[];
    const identity =
      identities.find((x) => x.email.toLowerCase() === msg.from.email.toLowerCase()) ?? identities[0];
    if (!identity)
      throw new ProviderRequestError("No sending identity is configured for this mailbox", false);

    const r = await this.call([
      [
        "Email/set",
        {
          accountId: this.accountId,
          create: { draft: await this.draftObject(msg, draftsId) },
          ...(replaceDraftId ? { destroy: [replaceDraftId] } : {}),
        },
        "e",
      ],
      [
        "EmailSubmission/set",
        {
          accountId: this.accountId,
          create: { sub: { identityId: identity.id, emailId: "#draft" } },
          onSuccessUpdateEmail: {
            "#sub": {
              [`mailboxIds/${draftsId}`]: null,
              [`mailboxIds/${sentId}`]: true,
              "keywords/$draft": null,
            },
          },
        },
        "s",
      ],
    ]);
    const created = (this.result(r, "e").created as Record<string, { id: string }> | null)?.draft;
    const notCreated = this.result(r, "s").notCreated as Record<
      string,
      { type: string; description?: string }
    > | null;
    if (!created) throw new ProviderRequestError("The mail server rejected the message", false);
    if (notCreated?.sub) {
      throw new ProviderRequestError(
        `Sending failed: ${notCreated.sub.description ?? notCreated.sub.type}`,
        false,
      );
    }
    return { id: created.id, undelivered: [] };
  }

  async upload(data: ArrayBuffer, type: string) {
    const url = this.session.uploadUrl.replace("{accountId}", encodeURIComponent(this.accountId));
    const res = await this.fetcher(url, {
      method: "POST",
      headers: { authorization: this.auth, "content-type": type },
      body: data,
    });
    if (!res.ok) throw new ProviderRequestError(`Upload failed (HTTP ${res.status})`, res.status >= 500);
    const body = (await res.json()) as { blobId: string; size: number };
    return { blobId: body.blobId, size: body.size };
  }

  async download(blobId: string) {
    const url = this.session.downloadUrl
      .replace("{accountId}", encodeURIComponent(this.accountId))
      .replace("{blobId}", encodeURIComponent(blobId))
      .replace("{name}", "file")
      .replace("{type}", encodeURIComponent("application/octet-stream"));
    const res = await this.fetcher(url, { headers: { authorization: this.auth } });
    if (res.status === 404) return null;
    if (!res.ok || !res.body)
      throw new ProviderRequestError(`Download failed (HTTP ${res.status})`, res.status >= 500);
    return { body: res.body, type: res.headers.get("content-type") ?? "application/octet-stream" };
  }

  async contacts(query: string, limit: number): Promise<EmailAddress[]> {
    const r = await this.call([
      [
        "Email/query",
        { accountId: this.accountId, sort: [{ property: "receivedAt", isAscending: false }], limit: 300 },
        "q",
      ],
      [
        "Email/get",
        {
          accountId: this.accountId,
          "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
          properties: ["from", "to", "cc"],
        },
        "g",
      ],
    ]);
    const all = (this.result(r, "g").list as JmapEmail[]).flatMap((e) => [
      ...(e.from ?? []),
      ...(e.to ?? []),
      ...(e.cc ?? []),
    ]);
    return collectContacts(all, this.address.toLowerCase(), query, limit);
  }

  /** JMAP push over the server's EventSource endpoint. One long-lived request, no polling. */
  async *watch(signal: AbortSignal): AsyncGenerator<MailEvent> {
    if (!this.session.eventSourceUrl)
      throw new ProviderRequestError("The mail server does not support push", false);
    const url = this.session.eventSourceUrl
      .replace("{types}", "Email,Mailbox")
      .replace("{closeafter}", "no")
      .replace("{ping}", "30");
    let res: Response;
    try {
      res = await this.fetcher(url, {
        headers: { authorization: this.auth, accept: "text/event-stream" },
        signal,
      });
    } catch {
      if (signal.aborted) return;
      throw new ProviderRequestError("Mail server is unreachable", true);
    }
    if (!res.ok || !res.body)
      throw new ProviderRequestError(`Push connection failed (HTTP ${res.status})`, res.status >= 500);
    for await (const e of parseSse(res.body, signal)) {
      if (e.event === "ping") yield "ping";
      else if (e.event === "state") yield "change";
    }
  }
}

export type { Attachment };
