import { C, type Store, type Write } from "@havins/database";
import {
  ProviderRequestError,
  type Attachment,
  type CreateMailboxRequest,
  type EmailAddress,
  type EmailProvider,
  type Folder,
  type FolderRole,
  type MailAdmin,
  type MailClient,
  type MailEvent,
  type Message,
  type MessageSummary,
  type OutgoingMessage,
  type ProviderDomain,
  type ProviderHealth,
  type SendResult,
} from "./types";

/**
 * DEVELOPMENT ONLY. A tiny mail server simulation kept in the app's Store, so local testing
 * works without a VPS: mailboxes, folders, internal delivery between local mailboxes,
 * attachments and a live change feed. It never sends anything to the internet; outside
 * recipients are reported as undelivered. createEmailProvider refuses it in production.
 */

const FOLDERS: { role: FolderRole; name: string }[] = [
  { role: "inbox", name: "Inbox" },
  { role: "drafts", name: "Drafts" },
  { role: "sent", name: "Sent" },
  { role: "archive", name: "Archive" },
  { role: "junk", name: "Junk" },
  { role: "trash", name: "Trash" },
];
const ROLES = new Set<string>(FOLDERS.map((f) => f.role));
/** Firestore documents are capped at 1 MiB, so blob data is split. */
const CHUNK_CHARS = 700_000;

const enc = new TextEncoder();

function b64(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < arr.length; i += 0x8000) s += String.fromCharCode(...arr.subarray(i, i + 0x8000));
  return btoa(s);
}

function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return b64(bits);
}

const ITERATIONS = 100_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${await pbkdf2(password, salt, ITERATIONS)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2" || !iter || !salt || !hash) return false;
  const candidate = await pbkdf2(password, unb64(salt), Number(iter));
  if (candidate.length !== hash.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= candidate.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}

type Account = { id: string; passwordHash: string; displayName: string; aliases: string[] };

type Row = {
  id: string;
  owner: string;
  folder: FolderRole;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string;
  textBody: string;
  htmlBody: string | null;
  attachments: Attachment[];
  messageId: string;
  inReplyTo: string | null;
  seen: boolean;
  flagged: boolean;
  receivedAt: number;
};

type Blob = { id: string; owner: string; type: string; size: number; chunks: number };

function summary(r: Row): MessageSummary {
  return {
    id: r.id,
    folderIds: [r.folder],
    from: r.from,
    to: r.to,
    subject: r.subject,
    preview: r.textBody.replace(/\s+/g, " ").trim().slice(0, 160),
    receivedAt: r.receivedAt,
    seen: r.seen,
    flagged: r.flagged,
    hasAttachment: r.attachments.length > 0,
  };
}

class MockAdmin implements MailAdmin {
  constructor(private readonly db: Store) {}

  async createDomain(name: string): Promise<ProviderDomain> {
    return {
      providerDomainId: `mock:${name}`,
      requiredRecords: [
        { type: "MX", host: name, value: "mx.mock-mail-server.invalid", priority: 10, purpose: "mx" },
        { type: "TXT", host: name, value: "v=spf1 include:mock-mail-server.invalid -all", purpose: "spf" },
      ],
    };
  }

  async deleteDomain(): Promise<void> {}

  async createMailbox(req: CreateMailboxRequest): Promise<{ providerMailboxId: string }> {
    if (await this.db.get(C.mockAccounts, req.address)) {
      throw new ProviderRequestError("Mailbox already exists on the mail server", false);
    }
    const account: Account = {
      id: req.address,
      displayName: req.displayName,
      passwordHash: await hashPassword(req.password),
      aliases: [],
    };
    await this.db.commit([{ type: "create", collection: C.mockAccounts, id: req.address, data: account }]);
    return { providerMailboxId: req.address };
  }

  async updateMailbox(id: string, changes: { displayName?: string; password?: string }): Promise<void> {
    const set: Partial<Account> = {};
    if (changes.displayName) set.displayName = changes.displayName;
    if (changes.password) set.passwordHash = await hashPassword(changes.password);
    if (Object.keys(set).length > 0)
      await this.db.commit([{ type: "update", collection: C.mockAccounts, id, data: set }]);
  }

  async deleteMailbox(id: string): Promise<void> {
    const [messages, blobs] = await Promise.all([
      this.db.query<Row>(C.mockMessages, { where: [["owner", "==", id]] }),
      this.db.query<Blob>(C.mockBlobs, { where: [["owner", "==", id]] }),
    ]);
    const writes: Write[] = [
      ...messages.map((m): Write => ({ type: "delete", collection: C.mockMessages, id: m.id })),
      ...blobs.flatMap((b): Write[] => [
        { type: "delete", collection: C.mockBlobs, id: b.id },
        ...Array.from({ length: b.chunks }, (_, i): Write => ({
          type: "delete",
          collection: C.mockBlobChunks,
          id: `${b.id}_${i}`,
        })),
      ]),
      { type: "delete", collection: C.mockAccounts, id },
    ];
    for (let i = 0; i < writes.length; i += 450) await this.db.commit(writes.slice(i, i + 450));
  }

  private async account(id: string): Promise<Account> {
    const row = await this.db.get<Account>(C.mockAccounts, id);
    if (!row) throw new ProviderRequestError("Mailbox not found on the mail server", false);
    return row;
  }

  async addAlias(id: string, alias: string): Promise<{ providerAliasId: string }> {
    const acct = await this.account(id);
    await this.db.commit([
      {
        type: "update",
        collection: C.mockAccounts,
        id,
        data: { aliases: [...new Set([...acct.aliases, alias])] },
      },
    ]);
    return { providerAliasId: alias };
  }

  async removeAlias(id: string, alias: string): Promise<void> {
    const acct = await this.db.get<Account>(C.mockAccounts, id);
    if (!acct) return;
    await this.db.commit([
      {
        type: "update",
        collection: C.mockAccounts,
        id,
        data: { aliases: acct.aliases.filter((a) => a !== alias) },
      },
    ]);
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      ok: true,
      latencyMs: 0,
      detail: "Development mock mail server. No real mail is sent or received.",
    };
  }
}

export interface MockOptions {
  /** How often watch() checks for changes. */
  watchIntervalMs?: number;
  /** watch() ends after this many checks; clients reconnect (bounds Worker subrequests). */
  watchMaxChecks?: number;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

class MockClient implements MailClient {
  constructor(
    private readonly db: Store,
    readonly address: string,
    private readonly options: Required<MockOptions>,
  ) {}

  private async own(id: string): Promise<Row | null> {
    const row = await this.db.get<Row>(C.mockMessages, id);
    return row && row.owner === this.address ? row : null;
  }

  private all(folder?: FolderRole) {
    const where: [string, "==", unknown][] = [["owner", "==", this.address]];
    if (folder) where.push(["folder", "==", folder]);
    return this.db.query<Row>(C.mockMessages, { where });
  }

  async folders(): Promise<Folder[]> {
    const rows = await this.all();
    return FOLDERS.map((f) => {
      const inFolder = rows.filter((r) => r.folder === f.role);
      return {
        id: f.role,
        name: f.name,
        role: f.role,
        total: inFolder.length,
        unread: inFolder.filter((r) => !r.seen).length,
      };
    });
  }

  async list(opts: { folderId: string; search?: string; limit: number; offset: number }) {
    if (!ROLES.has(opts.folderId)) return { total: 0, messages: [] };
    let rows = await this.all(opts.folderId as FolderRole);
    if (opts.search) {
      const q = opts.search.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.subject.toLowerCase().includes(q) ||
          r.textBody.toLowerCase().includes(q) ||
          r.from.some((a) => a.email.includes(q) || (a.name ?? "").toLowerCase().includes(q)),
      );
    }
    rows.sort((a, b) => b.receivedAt - a.receivedAt);
    return { total: rows.length, messages: rows.slice(opts.offset, opts.offset + opts.limit).map(summary) };
  }

  async get(id: string): Promise<Message | null> {
    const r = await this.own(id);
    if (!r) return null;
    return {
      ...summary(r),
      cc: r.cc,
      replyTo: [],
      messageId: r.messageId,
      references: r.inReplyTo ? [r.inReplyTo] : [],
      text: r.textBody,
      html: r.htmlBody,
      attachments: r.attachments,
    };
  }

  async update(id: string, changes: { seen?: boolean; flagged?: boolean; folderId?: string }): Promise<void> {
    if (!(await this.own(id))) throw new ProviderRequestError("Message not found", false);
    const set: Partial<Row> = {};
    if (changes.seen !== undefined) set.seen = changes.seen;
    if (changes.flagged !== undefined) set.flagged = changes.flagged;
    if (changes.folderId !== undefined) {
      if (!ROLES.has(changes.folderId)) throw new ProviderRequestError("Unknown folder", false);
      set.folder = changes.folderId as FolderRole;
    }
    await this.db.commit([{ type: "update", collection: C.mockMessages, id, data: set }]);
  }

  async destroy(id: string): Promise<void> {
    if (await this.own(id)) await this.db.commit([{ type: "delete", collection: C.mockMessages, id }]);
  }

  private row(
    msg: OutgoingMessage,
    owner: string,
    folder: FolderRole,
    attachments: Attachment[],
    seen: boolean,
  ): Row {
    return {
      id: crypto.randomUUID(),
      owner,
      folder,
      from: [msg.from],
      to: msg.to.map((email) => ({ name: null, email })),
      cc: msg.cc.map((email) => ({ name: null, email })),
      subject: msg.subject,
      textBody: msg.text,
      htmlBody: null,
      attachments,
      messageId: `<${crypto.randomUUID()}@mock.invalid>`,
      inReplyTo: msg.inReplyTo?.messageId ?? null,
      seen,
      flagged: false,
      receivedAt: Date.now(),
    };
  }

  async send(msg: OutgoingMessage, replaceDraftId?: string): Promise<SendResult> {
    await this.assertOwnBlobs(msg.attachments);
    const sent = this.row(msg, this.address, "sent", msg.attachments, true);
    const recipients = [...new Set([...msg.to, ...msg.cc, ...msg.bcc].map((r) => r.toLowerCase()))];
    const accounts = await this.db.query<Account>(C.mockAccounts);
    const resolve = (addr: string) => accounts.find((a) => a.id === addr || a.aliases.includes(addr))?.id;

    const undelivered: string[] = [];
    const writes: Write[] = [{ type: "create", collection: C.mockMessages, id: sent.id, data: sent }];
    for (const rcpt of recipients) {
      const owner = resolve(rcpt);
      if (!owner) {
        undelivered.push(rcpt);
        continue;
      }
      const copies = await this.copyBlobs(msg.attachments, owner);
      const delivered = { ...this.row(msg, owner, "inbox", copies, false), messageId: sent.messageId };
      writes.push({ type: "create", collection: C.mockMessages, id: delivered.id, data: delivered });
    }
    if (replaceDraftId && (await this.own(replaceDraftId)))
      writes.push({ type: "delete", collection: C.mockMessages, id: replaceDraftId });
    await this.db.commit(writes);
    return { id: sent.id, undelivered };
  }

  async saveDraft(msg: OutgoingMessage, replaceDraftId?: string): Promise<{ id: string }> {
    await this.assertOwnBlobs(msg.attachments);
    const draft = this.row(msg, this.address, "drafts", msg.attachments, true);
    const writes: Write[] = [{ type: "create", collection: C.mockMessages, id: draft.id, data: draft }];
    if (replaceDraftId && (await this.own(replaceDraftId)))
      writes.push({ type: "delete", collection: C.mockMessages, id: replaceDraftId });
    await this.db.commit(writes);
    return { id: draft.id };
  }

  private async assertOwnBlobs(attachments: Attachment[]) {
    for (const a of attachments) {
      const blob = await this.db.get<Blob>(C.mockBlobs, a.blobId);
      if (!blob || blob.owner !== this.address) throw new ProviderRequestError("Attachment not found", false);
    }
  }

  private async readBlob(blob: Blob): Promise<string> {
    const parts = await Promise.all(
      Array.from({ length: blob.chunks }, (_, i) =>
        this.db.get<{ data: string }>(C.mockBlobChunks, `${blob.id}_${i}`),
      ),
    );
    return parts.map((p) => p?.data ?? "").join("");
  }

  private async writeBlob(owner: string, type: string, size: number, data: string): Promise<string> {
    const id = crypto.randomUUID();
    const chunks = Math.max(1, Math.ceil(data.length / CHUNK_CHARS));
    const writes: Write[] = Array.from({ length: chunks }, (_, i) => ({
      type: "create" as const,
      collection: C.mockBlobChunks,
      id: `${id}_${i}`,
      data: { id: `${id}_${i}`, data: data.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS) },
    }));
    writes.push({
      type: "create",
      collection: C.mockBlobs,
      id,
      data: { id, owner, type, size, chunks } satisfies Blob,
    });
    await this.db.commit(writes);
    return id;
  }

  private async copyBlobs(attachments: Attachment[], owner: string): Promise<Attachment[]> {
    const out: Attachment[] = [];
    for (const a of attachments) {
      const blob = await this.db.get<Blob>(C.mockBlobs, a.blobId);
      if (!blob) continue;
      out.push({
        ...a,
        blobId: await this.writeBlob(owner, blob.type, blob.size, await this.readBlob(blob)),
      });
    }
    return out;
  }

  async upload(data: ArrayBuffer, type: string) {
    return {
      blobId: await this.writeBlob(this.address, type, data.byteLength, b64(data)),
      size: data.byteLength,
    };
  }

  async download(blobId: string) {
    const blob = await this.db.get<Blob>(C.mockBlobs, blobId);
    if (!blob || blob.owner !== this.address) return null;
    return { body: unb64(await this.readBlob(blob)).buffer, type: blob.type };
  }

  async contacts(query: string, limit: number): Promise<EmailAddress[]> {
    const rows = (await this.all()).sort((a, b) => b.receivedAt - a.receivedAt).slice(0, 500);
    return collectContacts(
      rows.flatMap((r) => [...r.from, ...r.to, ...r.cc]),
      this.address,
      query,
      limit,
    );
  }

  /** Cheap fingerprint of the mailbox (aggregate counts only). */
  private async fingerprint(): Promise<string> {
    const own: [string, "==", unknown] = ["owner", "==", this.address];
    const counts = await Promise.all([
      this.db.count(C.mockMessages, [own]),
      this.db.count(C.mockMessages, [own, ["seen", "==", false]]),
      this.db.count(C.mockMessages, [own, ["folder", "==", "inbox"]]),
      this.db.count(C.mockMessages, [own, ["flagged", "==", true]]),
    ]);
    return counts.join(":");
  }

  async *watch(signal: AbortSignal): AsyncGenerator<MailEvent> {
    const { watchIntervalMs, watchMaxChecks } = this.options;
    const pingEvery = Math.max(1, Math.round(25_000 / watchIntervalMs));
    let last = await this.fingerprint();
    for (let i = 1; i <= watchMaxChecks && !signal.aborted; i++) {
      await sleep(watchIntervalMs, signal);
      if (signal.aborted) return;
      const now = await this.fingerprint();
      if (now !== last) {
        last = now;
        yield "change";
      } else if (i % pingEvery === 0) yield "ping";
    }
  }
}

/** Dedupes addresses, drops the user's own, and filters by a case-insensitive substring. */
export function collectContacts(
  all: EmailAddress[],
  self: string,
  query: string,
  limit: number,
): EmailAddress[] {
  const q = query.toLowerCase();
  const seen = new Map<string, EmailAddress>();
  for (const a of all) {
    const email = a.email.toLowerCase();
    if (email === self || seen.has(email)) continue;
    if (q && !email.includes(q) && !(a.name ?? "").toLowerCase().includes(q)) continue;
    seen.set(email, { name: a.name, email });
    if (seen.size >= limit) break;
  }
  return [...seen.values()];
}

export class MockEmailProvider implements EmailProvider {
  readonly key = "mock";
  readonly isMock = true;
  readonly admin: MailAdmin;
  private readonly options: Required<MockOptions>;

  constructor(
    private readonly db: Store,
    options: MockOptions = {},
  ) {
    this.admin = new MockAdmin(db);
    this.options = {
      watchIntervalMs: options.watchIntervalMs ?? 3000,
      watchMaxChecks: options.watchMaxChecks ?? 40,
    };
  }

  async authenticate(address: string, password: string): Promise<MailClient | null> {
    const acct = await this.db.get<Account>(C.mockAccounts, address.toLowerCase());
    if (!acct || !(await verifyPassword(password, acct.passwordHash))) return null;
    return new MockClient(this.db, acct.id, this.options);
  }
}
