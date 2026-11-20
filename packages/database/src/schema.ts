/**
 * Firestore collections and the shape of their documents. Every document stores its own
 * `id`. Timestamps are Unix epoch milliseconds. Message content is never stored here:
 * mail lives on the mail server.
 */
export const C = {
  /** Admin console accounts. Document id = Firebase uid. */
  users: "users",
  domains: "domains",
  mailboxes: "mailboxes",
  aliases: "aliases",
  /** Document id = SHA-256 of the cookie token. */
  adminSessions: "adminSessions",
  /** Document id = SHA-256 of the cookie token. */
  mailSessions: "mailSessions",
  auditLogs: "auditLogs",
  /** Uniqueness claims: `address:<email>` and `domain:<name>`. */
  claims: "claims",
  // Development-only mock mail server (MockEmailProvider; refused in production).
  mockAccounts: "mockAccounts",
  mockMessages: "mockMessages",
  mockBlobs: "mockBlobs",
  mockBlobChunks: "mockBlobChunks",
} as const;

export type UserRecord = {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  status: "active" | "disabled";
  lastLoginAt: number | null;
  createdAt: number;
};

export type DomainRecord = {
  id: string;
  name: string;
  status: "active" | "provider_error";
  providerDomainId: string | null;
  /** JSON array of the DNS records the mail server requires. */
  providerRecords: string | null;
  createdAt: number;
};

export type MailboxRecord = {
  id: string;
  domainId: string;
  localPart: string;
  address: string;
  displayName: string;
  /** Null = unlimited. */
  quotaMb: number | null;
  status: "provisioning" | "active" | "failed" | "disabled";
  providerMailboxId: string | null;
  lastError: string | null;
  lastLoginAt: number | null;
  createdAt: number;
};

export type AliasRecord = {
  id: string;
  domainId: string;
  address: string;
  destinationMailboxId: string;
  providerAliasId: string | null;
  createdAt: number;
};

export type AdminSessionRecord = {
  id: string;
  userId: string;
  mfaVerified: boolean;
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
  createdAt: number;
};

export type MailSessionRecord = {
  id: string;
  mailboxId: string;
  /** Mailbox password sealed with AES-256-GCM (MAIL_SESSION_KEY). Never plain text. */
  credential: string;
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
  createdAt: number;
};

export type AuditRecord = {
  id: string;
  actorType: "admin" | "mail" | "system";
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  /** JSON. Never contains passwords, tokens or message content. */
  metadata: string | null;
  ip: string | null;
  createdAt: number;
};

export type ClaimRecord = {
  id: string;
  ownerType: "mailbox" | "alias" | "domain";
  ownerId: string;
};

export const addressClaim = (address: string) => `address:${address.toLowerCase()}`;
export const domainClaim = (name: string) => `domain:${name.toLowerCase()}`;
