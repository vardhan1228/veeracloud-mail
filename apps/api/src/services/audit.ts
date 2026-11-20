import type { Context } from "hono";
import { C, type AuditRecord, type Write } from "@havins/database";
import type { AppEnv } from "../env";

export interface AuditEntry {
  action: string;
  targetType?: string;
  targetId?: string;
  /** Must never contain passwords, tokens or message content. */
  metadata?: Record<string, unknown>;
}

export function clientIp(c: Context<AppEnv>): string | null {
  return c.req.header("cf-connecting-ip") ?? null;
}

/** Builds the audit write so callers commit it atomically with the change it records. */
export function auditInsert(c: Context<AppEnv>, entry: AuditEntry): Write {
  const { now } = c.get("deps");
  const user = c.get("user");
  const mailbox = c.get("mailbox");
  const id = crypto.randomUUID();
  const data: AuditRecord = {
    id,
    actorType: user ? "admin" : mailbox ? "mail" : "system",
    actorId: user?.id ?? mailbox?.id ?? null,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
    ip: clientIp(c),
    createdAt: now(),
  };
  return { type: "create", collection: C.auditLogs, id, data };
}

export async function audit(c: Context<AppEnv>, entry: AuditEntry): Promise<void> {
  await c.get("deps").db.commit([auditInsert(c, entry)]);
}
