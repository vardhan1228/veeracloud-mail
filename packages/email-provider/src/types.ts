/**
 * Mail is hosted by a real mail server (Stalwart on a VPS). Cloudflare Workers cannot run
 * SMTP/IMAP; this package is the only path from the platform to mail.
 */

export interface DnsRecordRequirement {
  type: "MX" | "TXT" | "CNAME" | "A" | "AAAA" | "SRV" | "TLSA";
  /** Fully qualified host name without trailing dot. */
  host: string;
  value: string;
  priority?: number;
  purpose: "mx" | "spf" | "dkim" | "dmarc" | "autoconfig" | "other";
}

export interface ProviderDomain {
  providerDomainId: string;
  /** Records to publish, exactly as returned by the mail server. */
  requiredRecords: DnsRecordRequirement[];
}

export interface CreateMailboxRequest {
  address: string;
  displayName: string;
  /** Null = no quota. */
  quotaMb: number | null;
  /** Plain-text initial password. Adapters forward it to the server and never log or persist it. */
  password: string;
}

export interface ProviderHealth {
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

/** Server administration, performed with the platform's admin credentials. */
export interface MailAdmin {
  createDomain(name: string): Promise<ProviderDomain>;
  deleteDomain(providerDomainId: string): Promise<void>;
  createMailbox(req: CreateMailboxRequest): Promise<{ providerMailboxId: string }>;
  updateMailbox(
    providerMailboxId: string,
    changes: { displayName?: string; quotaMb?: number | null; enabled?: boolean; password?: string },
  ): Promise<void>;
  deleteMailbox(providerMailboxId: string): Promise<void>;
  addAlias(providerMailboxId: string, alias: string): Promise<{ providerAliasId: string }>;
  removeAlias(providerMailboxId: string, providerAliasId: string): Promise<void>;
  healthCheck(): Promise<ProviderHealth>;
}

export interface EmailAddress {
  name: string | null;
  email: string;
}

export type FolderRole = "inbox" | "sent" | "drafts" | "junk" | "trash" | "archive";

export interface Folder {
  id: string;
  name: string;
  role: FolderRole | null;
  unread: number;
  total: number;
}

export interface Attachment {
  blobId: string;
  name: string;
  type: string;
  size: number;
}

export interface MessageSummary {
  id: string;
  folderIds: string[];
  from: EmailAddress[];
  to: EmailAddress[];
  subject: string;
  preview: string;
  receivedAt: number;
  seen: boolean;
  flagged: boolean;
  hasAttachment: boolean;
}

export interface Message extends MessageSummary {
  cc: EmailAddress[];
  replyTo: EmailAddress[];
  messageId: string | null;
  references: string[];
  text: string | null;
  /** Untrusted HTML. Clients must render it sandboxed. */
  html: string | null;
  attachments: Attachment[];
}

export interface OutgoingMessage {
  from: EmailAddress;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  attachments: Attachment[];
  inReplyTo?: { messageId: string | null; references: string[] };
}

export interface SendResult {
  id: string;
  /** Recipients the server could not accept (e.g. the dev mock does not deliver outside). */
  undelivered: string[];
}

/** One employee's mailbox, authenticated with their own credentials. */
export interface MailClient {
  readonly address: string;
  folders(): Promise<Folder[]>;
  list(opts: { folderId: string; search?: string; limit: number; offset: number }): Promise<{
    total: number;
    messages: MessageSummary[];
  }>;
  get(id: string): Promise<Message | null>;
  update(id: string, changes: { seen?: boolean; flagged?: boolean; folderId?: string }): Promise<void>;
  destroy(id: string): Promise<void>;
  send(msg: OutgoingMessage, replaceDraftId?: string): Promise<SendResult>;
  saveDraft(msg: OutgoingMessage, replaceDraftId?: string): Promise<{ id: string }>;
  upload(data: ArrayBuffer, type: string): Promise<{ blobId: string; size: number }>;
  download(blobId: string): Promise<{ body: ReadableStream<Uint8Array> | ArrayBuffer; type: string } | null>;
  /** Addresses this user has exchanged mail with, for autocomplete. */
  contacts(query: string, limit: number): Promise<EmailAddress[]>;
  /**
   * Live change feed for this mailbox: yields "change" when mail arrives or state changes, and
   * "ping" periodically so idle connections stay open. Ends when `signal` aborts.
   */
  watch(signal: AbortSignal): AsyncIterable<MailEvent>;
}

export type MailEvent = "change" | "ping";

export interface EmailProvider {
  readonly key: string;
  readonly isMock: boolean;
  readonly admin: MailAdmin;
  /** Returns null when the address/password pair is rejected. */
  authenticate(address: string, password: string): Promise<MailClient | null>;
}

export class ProviderNotConfiguredError extends Error {
  constructor(message = "No mail server is configured for this environment") {
    super(message);
    this.name = "ProviderNotConfiguredError";
  }
}

/** The mail server rejected or failed the request. `retryable` distinguishes outages from bad input. */
export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }
}
