export interface Me {
  address: string;
  displayName: string;
  companyName: string;
  developmentServer: boolean;
}

export type FolderRole = "inbox" | "sent" | "drafts" | "junk" | "trash" | "archive";

export interface Folder {
  id: string;
  name: string;
  role: FolderRole | null;
  unread: number;
  total: number;
}

export interface EmailAddress {
  name: string | null;
  email: string;
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
  html: string | null;
  attachments: Attachment[];
}

export interface Listing {
  total: number;
  messages: MessageSummary[];
  limit: number;
  offset: number;
}

/** Folder key used in URLs and API calls: the role when there is one (both providers accept it). */
export const folderKey = (f: Folder) => f.role ?? f.id;

export const formatAddress = (a: EmailAddress) => (a.name ? `${a.name} <${a.email}>` : a.email);
export const shortName = (a: EmailAddress | undefined) =>
  a ? a.name || a.email.split("@")[0]! : "(unknown)";
