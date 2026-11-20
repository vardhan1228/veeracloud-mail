import { Hono, type Context } from "hono";
import {
  C,
  WriteConflictError,
  addressClaim,
  domainClaim,
  type AliasRecord,
  type AuditRecord,
  type ClaimRecord,
  type DomainRecord,
  type MailboxRecord,
  type Write,
} from "@havins/database";
import { ProviderNotConfiguredError, ProviderRequestError } from "@havins/email-provider";
import {
  addDomainSchema,
  createAliasSchema,
  createMailboxSchema,
  idSchema,
  paginationSchema,
  resetPasswordSchema,
  updateMailboxSchema,
} from "@havins/validation";
import type { AppEnv } from "../env";
import { conflict, notFound, parse } from "../errors";
import { requireAdmin } from "../middleware";
import { auditInsert } from "../services/audit";
import { mailSessionDeletes } from "../services/sessions";

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use("*", requireAdmin);

const body = async (c: Context<AppEnv>) => c.req.json().catch(() => null);
const del = (collection: string, id: string): Write => ({ type: "delete", collection, id });

async function load<T>(c: Context<AppEnv>, collection: string, what: string): Promise<T> {
  const parsed = idSchema.safeParse(c.req.param("id"));
  if (!parsed.success) throw notFound(what);
  const row = await c.get("deps").db.get<T>(collection, parsed.data);
  if (!row) throw notFound(what);
  return row;
}

/** Commits in chunks (Firestore allows 500 writes per commit). */
async function commitAll(c: Context<AppEnv>, writes: Write[]) {
  for (let i = 0; i < writes.length; i += 450) await c.get("deps").db.commit(writes.slice(i, i + 450));
}

// ---------------- Overview ----------------

adminRoutes.get("/stats", async (c) => {
  const { db, now } = c.get("deps");
  const [domains, active, disabled, aliases, online] = await Promise.all([
    db.count(C.domains),
    db.count(C.mailboxes, [["status", "==", "active"]]),
    db.count(C.mailboxes, [["status", "==", "disabled"]]),
    db.count(C.aliases),
    db.count(C.mailSessions, [["expiresAt", ">", now()]]),
  ]);
  return c.json({
    domains,
    activeMailboxes: active,
    disabledMailboxes: disabled,
    aliases,
    webmailSessions: online,
  });
});

adminRoutes.get("/server", async (c) => {
  try {
    const provider = c.get("deps").emailProvider();
    const health = await provider.admin.healthCheck();
    return c.json({ configured: true, provider: provider.key, isMock: provider.isMock, ...health });
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError)
      return c.json({ configured: false, ok: false, detail: err.message });
    throw err;
  }
});

adminRoutes.get("/audit-logs", async (c) => {
  const { limit, offset } = parse(paginationSchema, c.req.query());
  const rows = await c
    .get("deps")
    .db.query<AuditRecord>(C.auditLogs, {
      orderBy: { field: "createdAt", direction: "desc" },
      limit,
      offset,
    });
  return c.json({ auditLogs: rows, limit, offset });
});

// ---------------- Domains ----------------

function presentDomain(d: DomainRecord) {
  return {
    id: d.id,
    name: d.name,
    status: d.status,
    mailReady: d.providerDomainId !== null,
    records: d.providerRecords ? JSON.parse(d.providerRecords) : null,
    createdAt: d.createdAt,
  };
}

adminRoutes.get("/domains", async (c) => {
  const rows = await c.get("deps").db.query<DomainRecord>(C.domains);
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return c.json({ domains: rows.map(presentDomain) });
});

/** Registers the domain on the mail server (which also creates its DKIM key). */
async function provisionDomain(c: Context<AppEnv>, domain: DomainRecord) {
  const { db } = c.get("deps");
  try {
    const result = await c.get("deps").emailProvider().admin.createDomain(domain.name);
    const set = {
      status: "active" as const,
      providerDomainId: result.providerDomainId,
      providerRecords: JSON.stringify(result.requiredRecords),
    };
    await db.commit([{ type: "update", collection: C.domains, id: domain.id, data: set }]);
    return { domain: { ...domain, ...set }, providerStatus: "ready" as const };
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError)
      return { domain, providerStatus: "not_configured" as const };
    if (err instanceof ProviderRequestError) {
      await db.commit([
        { type: "update", collection: C.domains, id: domain.id, data: { status: "provider_error" } },
      ]);
      return {
        domain: { ...domain, status: "provider_error" as const },
        providerStatus: "error" as const,
        error: err.message,
      };
    }
    throw err;
  }
}

adminRoutes.post("/domains", async (c) => {
  const { db, now } = c.get("deps");
  const { name } = parse(addDomainSchema, await body(c));
  const domain: DomainRecord = {
    id: crypto.randomUUID(),
    name,
    status: "active",
    providerDomainId: null,
    providerRecords: null,
    createdAt: now(),
  };
  const claim: ClaimRecord = { id: domainClaim(name), ownerType: "domain", ownerId: domain.id };
  try {
    await db.commit([
      { type: "create", collection: C.claims, id: claim.id, data: claim },
      { type: "create", collection: C.domains, id: domain.id, data: domain },
      auditInsert(c, {
        action: "domain.added",
        targetType: "domain",
        targetId: domain.id,
        metadata: { name },
      }),
    ]);
  } catch (err) {
    if (err instanceof WriteConflictError)
      throw conflict("domain_exists", "This domain has already been added");
    throw err;
  }
  const result = await provisionDomain(c, domain);
  return c.json(
    { domain: presentDomain(result.domain), providerStatus: result.providerStatus, error: result.error },
    201,
  );
});

adminRoutes.post("/domains/:id/provision", async (c) => {
  const domain = await load<DomainRecord>(c, C.domains, "Domain");
  const result = await provisionDomain(c, domain);
  return c.json({
    domain: presentDomain(result.domain),
    providerStatus: result.providerStatus,
    error: result.error,
  });
});

adminRoutes.delete("/domains/:id", async (c) => {
  const { db } = c.get("deps");
  const domain = await load<DomainRecord>(c, C.domains, "Domain");
  if ((await db.count(C.mailboxes, [["domainId", "==", domain.id]])) > 0) {
    throw conflict("domain_in_use", "Delete this domain's mailboxes first");
  }
  if (domain.providerDomainId)
    await c.get("deps").emailProvider().admin.deleteDomain(domain.providerDomainId);
  const aliases = await db.query<AliasRecord>(C.aliases, { where: [["domainId", "==", domain.id]] });
  await commitAll(c, [
    ...aliases.flatMap((a) => [del(C.aliases, a.id), del(C.claims, addressClaim(a.address))]),
    del(C.domains, domain.id),
    del(C.claims, domainClaim(domain.name)),
    auditInsert(c, {
      action: "domain.deleted",
      targetType: "domain",
      targetId: domain.id,
      metadata: { name: domain.name },
    }),
  ]);
  return c.json({ ok: true });
});

// ---------------- Mailboxes (employees) ----------------

function presentMailbox(m: MailboxRecord) {
  return {
    id: m.id,
    address: m.address,
    displayName: m.displayName,
    domainId: m.domainId,
    quotaMb: m.quotaMb,
    status: m.status,
    lastError: m.lastError,
    lastLoginAt: m.lastLoginAt,
    createdAt: m.createdAt,
  };
}

/** Throws address_taken unless the address is free. A failed mailbox attempt does not block a retry. */
async function assertAddressFree(c: Context<AppEnv>, address: string) {
  const { db } = c.get("deps");
  const claim = await db.get<ClaimRecord>(C.claims, addressClaim(address));
  if (!claim) return;
  if (claim.ownerType === "mailbox") {
    const m = await db.get<MailboxRecord>(C.mailboxes, claim.ownerId);
    if (!m || m.status === "failed") {
      await db.commit([del(C.claims, claim.id), ...(m ? [del(C.mailboxes, m.id)] : [])]);
      return;
    }
  }
  throw conflict("address_taken", `${address} is already in use`);
}

async function readyDomain(c: Context<AppEnv>, domainId: string) {
  const domain = await c.get("deps").db.get<DomainRecord>(C.domains, domainId);
  if (!domain) throw notFound("Domain");
  if (!domain.providerDomainId)
    throw conflict("domain_not_ready", "This domain is not set up on the mail server yet");
  return domain;
}

adminRoutes.get("/mailboxes", async (c) => {
  const rows = await c.get("deps").db.query<MailboxRecord>(C.mailboxes);
  rows.sort((a, b) => a.address.localeCompare(b.address));
  return c.json({ mailboxes: rows.map(presentMailbox) });
});

adminRoutes.post("/mailboxes", async (c) => {
  const { db, now } = c.get("deps");
  const input = parse(createMailboxSchema, await body(c));
  const provider = c.get("deps").emailProvider();
  const domain = await readyDomain(c, input.domainId);
  const address = `${input.localPart}@${domain.name}`;
  await assertAddressFree(c, address);

  const mailbox: MailboxRecord = {
    id: crypto.randomUUID(),
    domainId: domain.id,
    localPart: input.localPart,
    address,
    displayName: input.displayName,
    quotaMb: input.quotaMb ?? null,
    status: "provisioning",
    providerMailboxId: null,
    lastError: null,
    lastLoginAt: null,
    createdAt: now(),
  };
  try {
    await db.commit([
      {
        type: "create",
        collection: C.claims,
        id: addressClaim(address),
        data: { id: addressClaim(address), ownerType: "mailbox", ownerId: mailbox.id },
      },
      { type: "create", collection: C.mailboxes, id: mailbox.id, data: mailbox },
    ]);
  } catch (err) {
    if (err instanceof WriteConflictError) throw conflict("address_taken", `${address} is already in use`);
    throw err;
  }

  try {
    const result = await provider.admin.createMailbox({
      address,
      displayName: input.displayName,
      quotaMb: mailbox.quotaMb,
      password: input.password,
    });
    const set = { status: "active" as const, providerMailboxId: result.providerMailboxId, lastError: null };
    await db.commit([
      { type: "update", collection: C.mailboxes, id: mailbox.id, data: set },
      auditInsert(c, {
        action: "mailbox.created",
        targetType: "mailbox",
        targetId: mailbox.id,
        metadata: { address, quotaMb: mailbox.quotaMb },
      }),
    ]);
    return c.json({ mailbox: presentMailbox({ ...mailbox, ...set }) }, 201);
  } catch (err) {
    const message = err instanceof ProviderRequestError ? err.message : "Unexpected mail server error";
    await db.commit([
      {
        type: "update",
        collection: C.mailboxes,
        id: mailbox.id,
        data: { status: "failed", lastError: message },
      },
      auditInsert(c, {
        action: "mailbox.create_failed",
        targetType: "mailbox",
        targetId: mailbox.id,
        metadata: { address, error: message },
      }),
    ]);
    throw err;
  }
});

const loadMailbox = (c: Context<AppEnv>) => load<MailboxRecord>(c, C.mailboxes, "Mailbox");

adminRoutes.patch("/mailboxes/:id", async (c) => {
  const { db } = c.get("deps");
  const mailbox = await loadMailbox(c);
  const input = parse(updateMailboxSchema, await body(c));
  if (!mailbox.providerMailboxId)
    throw conflict("mailbox_not_ready", "This mailbox was never created on the mail server");
  await c.get("deps").emailProvider().admin.updateMailbox(mailbox.providerMailboxId, input);
  const set: Partial<MailboxRecord> = {};
  if (input.displayName !== undefined) set.displayName = input.displayName;
  if (input.quotaMb !== undefined) set.quotaMb = input.quotaMb;
  if (input.enabled !== undefined) set.status = input.enabled ? "active" : "disabled";
  await commitAll(c, [
    { type: "update", collection: C.mailboxes, id: mailbox.id, data: set },
    auditInsert(c, {
      action: "mailbox.updated",
      targetType: "mailbox",
      targetId: mailbox.id,
      metadata: { address: mailbox.address, ...input },
    }),
    // Disabling signs the employee out of webmail everywhere.
    ...(input.enabled === false ? await mailSessionDeletes(db, mailbox.id) : []),
  ]);
  return c.json({ mailbox: presentMailbox({ ...mailbox, ...set }) });
});

adminRoutes.post("/mailboxes/:id/password", async (c) => {
  const { db } = c.get("deps");
  const mailbox = await loadMailbox(c);
  const { password } = parse(resetPasswordSchema, await body(c));
  if (!mailbox.providerMailboxId)
    throw conflict("mailbox_not_ready", "This mailbox was never created on the mail server");
  await c.get("deps").emailProvider().admin.updateMailbox(mailbox.providerMailboxId, { password });
  // Existing webmail sessions hold the old password; end them.
  await commitAll(c, [
    ...(await mailSessionDeletes(db, mailbox.id)),
    auditInsert(c, {
      action: "mailbox.password_reset",
      targetType: "mailbox",
      targetId: mailbox.id,
      metadata: { address: mailbox.address },
    }),
  ]);
  return c.json({ ok: true });
});

adminRoutes.delete("/mailboxes/:id", async (c) => {
  const { db } = c.get("deps");
  const mailbox = await loadMailbox(c);
  if (mailbox.providerMailboxId)
    await c.get("deps").emailProvider().admin.deleteMailbox(mailbox.providerMailboxId);
  const aliases = await db.query<AliasRecord>(C.aliases, {
    where: [["destinationMailboxId", "==", mailbox.id]],
  });
  await commitAll(c, [
    ...(await mailSessionDeletes(db, mailbox.id)),
    ...aliases.flatMap((a) => [del(C.aliases, a.id), del(C.claims, addressClaim(a.address))]),
    del(C.mailboxes, mailbox.id),
    del(C.claims, addressClaim(mailbox.address)),
    auditInsert(c, {
      action: "mailbox.deleted",
      targetType: "mailbox",
      targetId: mailbox.id,
      metadata: { address: mailbox.address },
    }),
  ]);
  return c.json({ ok: true });
});

// ---------------- Aliases ----------------

adminRoutes.get("/aliases", async (c) => {
  const { db } = c.get("deps");
  const [aliases, mailboxes] = await Promise.all([
    db.query<AliasRecord>(C.aliases),
    db.query<MailboxRecord>(C.mailboxes),
  ]);
  const byId = new Map(mailboxes.map((m) => [m.id, m.address]));
  const rows = aliases
    .filter((a) => byId.has(a.destinationMailboxId))
    .map((a) => ({
      id: a.id,
      address: a.address,
      destinationMailboxId: a.destinationMailboxId,
      destination: byId.get(a.destinationMailboxId)!,
    }))
    .sort((a, b) => a.address.localeCompare(b.address));
  return c.json({ aliases: rows });
});

adminRoutes.post("/aliases", async (c) => {
  const { db, now } = c.get("deps");
  const input = parse(createAliasSchema, await body(c));
  const provider = c.get("deps").emailProvider();
  const domain = await readyDomain(c, input.domainId);
  const destination = await db.get<MailboxRecord>(C.mailboxes, input.destinationMailboxId);
  if (!destination) throw notFound("Destination mailbox");
  if (destination.status !== "active" || !destination.providerMailboxId) {
    throw conflict("mailbox_not_active", "The destination mailbox is not active");
  }
  const address = `${input.localPart}@${domain.name}`;
  await assertAddressFree(c, address);
  const result = await provider.admin.addAlias(destination.providerMailboxId, address);
  const alias: AliasRecord = {
    id: crypto.randomUUID(),
    domainId: domain.id,
    address,
    destinationMailboxId: destination.id,
    providerAliasId: result.providerAliasId,
    createdAt: now(),
  };
  try {
    await db.commit([
      {
        type: "create",
        collection: C.claims,
        id: addressClaim(address),
        data: { id: addressClaim(address), ownerType: "alias", ownerId: alias.id },
      },
      { type: "create", collection: C.aliases, id: alias.id, data: alias },
      auditInsert(c, {
        action: "alias.created",
        targetType: "alias",
        targetId: alias.id,
        metadata: { address, destination: destination.address },
      }),
    ]);
  } catch (err) {
    // Lost a race for the address: undo the server-side alias.
    await provider.admin
      .removeAlias(destination.providerMailboxId, result.providerAliasId)
      .catch(() => undefined);
    if (err instanceof WriteConflictError) throw conflict("address_taken", `${address} is already in use`);
    throw err;
  }
  return c.json(
    {
      alias: {
        id: alias.id,
        address,
        destinationMailboxId: destination.id,
        destination: destination.address,
      },
    },
    201,
  );
});

adminRoutes.delete("/aliases/:id", async (c) => {
  const { db } = c.get("deps");
  const alias = await load<AliasRecord>(c, C.aliases, "Alias");
  const destination = await db.get<MailboxRecord>(C.mailboxes, alias.destinationMailboxId);
  if (alias.providerAliasId && destination?.providerMailboxId) {
    await c
      .get("deps")
      .emailProvider()
      .admin.removeAlias(destination.providerMailboxId, alias.providerAliasId);
  }
  await db.commit([
    del(C.aliases, alias.id),
    del(C.claims, addressClaim(alias.address)),
    auditInsert(c, {
      action: "alias.deleted",
      targetType: "alias",
      targetId: alias.id,
      metadata: { address: alias.address },
    }),
  ]);
  return c.json({ ok: true });
});
