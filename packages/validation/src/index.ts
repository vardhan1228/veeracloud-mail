import { z } from "zod";

/** Lowercase domain name with at least one dot. No wildcards, no trailing dot. */
export const domainNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    "Enter a valid domain such as yourcompany.com",
  );

/** Local part of an address (before @). Conservative subset every mail server accepts. */
export const localPartSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/, "Use letters, numbers, dots, hyphens or underscores")
  .refine((v) => !v.includes(".."), "Consecutive dots are not allowed");

export const emailAddressSchema = z.email("Enter a valid email address").max(254).toLowerCase();

export const idSchema = z.uuid();

/**
 * Mailbox passwords go to the mail server and are never stored in plain text.
 * Length-based policy (NIST 800-63B) rather than composition rules.
 */
export const mailboxPasswordSchema = z.string().min(12, "Use at least 12 characters").max(128);

export const sessionExchangeSchema = z.object({
  idToken: z.string().min(20).max(4096),
  turnstileToken: z.string().max(2048).optional(),
});

export const addDomainSchema = z.object({ name: domainNameSchema });

export const createMailboxSchema = z.object({
  domainId: idSchema,
  localPart: localPartSchema,
  displayName: z.string().trim().min(1).max(120),
  /** Omit for unlimited. */
  quotaMb: z.number().int().min(100).max(10_485_760).nullable().optional(),
  password: mailboxPasswordSchema,
});

export const updateMailboxSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    quotaMb: z.number().int().min(100).max(10_485_760).nullable(),
    enabled: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

export const resetPasswordSchema = z.object({ password: mailboxPasswordSchema });

export const createAliasSchema = z.object({
  domainId: idSchema,
  localPart: localPartSchema,
  destinationMailboxId: idSchema,
});

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---------- Webmail ----------

export const mailLoginSchema = z.object({
  address: emailAddressSchema,
  password: z.string().min(1).max(128),
  turnstileToken: z.string().max(2048).optional(),
});

export const changeMailPasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: mailboxPasswordSchema,
});

export const folderRoleSchema = z.enum(["inbox", "sent", "drafts", "junk", "trash", "archive"]);

export const listMessagesSchema = paginationSchema.extend({
  folder: z.string().min(1).max(200).default("inbox"),
  q: z.string().trim().max(200).optional(),
});

export const updateMessageSchema = z
  .object({
    seen: z.boolean(),
    flagged: z.boolean(),
    /** Folder id to move to. */
    folder: z.string().min(1).max(200),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

const recipients = z.array(emailAddressSchema).max(100);

export const attachmentRefSchema = z.object({
  blobId: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(255),
  type: z.string().min(1).max(255),
  size: z.number().int().min(0),
});

export const composeSchema = z
  .object({
    to: recipients.default([]),
    cc: recipients.default([]),
    bcc: recipients.default([]),
    subject: z.string().max(998).default(""),
    text: z.string().max(1_000_000).default(""),
    attachments: z.array(attachmentRefSchema).max(20).default([]),
    /** Message being replied to or forwarded (sets threading headers). */
    inReplyToId: z.string().min(1).max(200).optional(),
    /** Draft to replace when saving again or sending a draft. */
    draftId: z.string().min(1).max(200).optional(),
  })
  .refine((v) => v.attachments.reduce((n, a) => n + a.size, 0) <= 25 * 1024 * 1024, {
    message: "Attachments can total at most 25 MB",
    path: ["attachments"],
  });

export const sendSchema = composeSchema.refine((v) => v.to.length + v.cc.length + v.bcc.length > 0, {
  message: "Add at least one recipient",
  path: ["to"],
});

export type ComposeInput = z.infer<typeof composeSchema>;
