import {
  ProviderRequestError,
  type CreateMailboxRequest,
  type DnsRecordRequirement,
  type MailAdmin,
  type ProviderDomain,
  type ProviderHealth,
} from "../types";

/**
 * Stalwart management REST API (https://stalw.art/docs/api/management/overview).
 * Principals are addressed by name; we use the full email address as the principal name.
 * Written against the v0.11+ API: verify against your server version with the checklist in
 * infrastructure/mail-server/STALWART.md before going live.
 */

export interface StalwartConfig {
  /** Base URL of the Stalwart HTTP listener, e.g. https://mail.yourcompany.com */
  baseUrl: string;
  /** Admin credentials (fallback admin or an API key principal). Worker secrets only. */
  adminUser: string;
  adminPassword: string;
  fetcher?: typeof fetch;
}

export function basicAuth(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

export class StalwartAdmin implements MailAdmin {
  private readonly fetcher: typeof fetch;
  private readonly auth: string;
  private readonly base: string;

  constructor(config: StalwartConfig) {
    this.fetcher = config.fetcher ?? fetch;
    this.auth = basicAuth(config.adminUser, config.adminPassword);
    this.base = config.baseUrl.replace(/\/+$/, "");
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetcher(`${this.base}/api${path}`, {
        method,
        headers: {
          authorization: this.auth,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ProviderRequestError("Mail server is unreachable", true);
    }
    const data = (await res.json().catch(() => null)) as {
      data?: T;
      error?: string;
      details?: string;
    } | null;
    if (!res.ok || data?.error) {
      const detail = data?.details ?? data?.error ?? `HTTP ${res.status}`;
      throw new ProviderRequestError(`Mail server rejected the request: ${detail}`, res.status >= 500);
    }
    return data?.data as T;
  }

  async createDomain(name: string): Promise<ProviderDomain> {
    await this.call("POST", "/principal", { type: "domain", name, description: name });
    // Generate a DKIM key so the DNS listing includes the signing record. Ignore "already exists".
    await this.call("POST", "/dkim", { id: null, algorithm: "Ed25519", domain: name, selector: null }).catch(
      (err: unknown) => {
        if (!(err instanceof ProviderRequestError) || err.retryable) throw err;
      },
    );
    return { providerDomainId: name, requiredRecords: await this.dnsRecords(name) };
  }

  /** Records Stalwart says the domain needs (MX, SPF, DKIM, DMARC, autoconfig, MTA-STS...). */
  async dnsRecords(name: string): Promise<DnsRecordRequirement[]> {
    const rows = await this.call<{ type: string; name: string; content: string }[]>(
      "GET",
      `/dns/records/${encodeURIComponent(name)}`,
    );
    return (rows ?? []).map((r) => parseRecord(r));
  }

  async deleteDomain(providerDomainId: string): Promise<void> {
    await this.call("DELETE", `/principal/${encodeURIComponent(providerDomainId)}`);
  }

  async createMailbox(req: CreateMailboxRequest): Promise<{ providerMailboxId: string }> {
    await this.call("POST", "/principal", {
      type: "individual",
      name: req.address,
      description: req.displayName,
      secrets: [req.password],
      emails: [req.address],
      quota: req.quotaMb == null ? 0 : req.quotaMb * 1024 * 1024,
      roles: ["user"],
    });
    return { providerMailboxId: req.address };
  }

  async updateMailbox(
    id: string,
    changes: { displayName?: string; quotaMb?: number | null; enabled?: boolean; password?: string },
  ): Promise<void> {
    const ops: { action: string; field: string; value: unknown }[] = [];
    if (changes.displayName !== undefined)
      ops.push({ action: "set", field: "description", value: changes.displayName });
    if (changes.quotaMb !== undefined) {
      ops.push({
        action: "set",
        field: "quota",
        value: changes.quotaMb == null ? 0 : changes.quotaMb * 1024 * 1024,
      });
    }
    if (changes.password !== undefined)
      ops.push({ action: "set", field: "secrets", value: [changes.password] });
    if (changes.enabled !== undefined) {
      // Removing the "authenticate" permission blocks IMAP/SMTP/JMAP logins while keeping the mail.
      ops.push({
        action: changes.enabled ? "removeItem" : "addItem",
        field: "disabledPermissions",
        value: "authenticate",
      });
    }
    if (ops.length > 0) await this.call("PATCH", `/principal/${encodeURIComponent(id)}`, ops);
  }

  async deleteMailbox(id: string): Promise<void> {
    await this.call("DELETE", `/principal/${encodeURIComponent(id)}`);
  }

  async addAlias(id: string, alias: string): Promise<{ providerAliasId: string }> {
    await this.call("PATCH", `/principal/${encodeURIComponent(id)}`, [
      { action: "addItem", field: "emails", value: alias },
    ]);
    return { providerAliasId: alias };
  }

  async removeAlias(id: string, alias: string): Promise<void> {
    await this.call("PATCH", `/principal/${encodeURIComponent(id)}`, [
      { action: "removeItem", field: "emails", value: alias },
    ]);
  }

  async healthCheck(): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      const res = await this.fetcher(`${this.base}/healthz/ready`);
      return {
        ok: res.ok,
        latencyMs: Date.now() - started,
        detail: res.ok ? "Stalwart is ready" : `HTTP ${res.status}`,
      };
    } catch {
      return { ok: false, latencyMs: Date.now() - started, detail: "Mail server is unreachable" };
    }
  }
}

const PURPOSE: Record<string, DnsRecordRequirement["purpose"]> = { MX: "mx" };

export function parseRecord(r: { type: string; name: string; content: string }): DnsRecordRequirement {
  const type = r.type.toUpperCase() as DnsRecordRequirement["type"];
  const host = r.name.replace(/\.$/, "");
  let value = r.content;
  let priority: number | undefined;
  if (type === "MX") {
    const m = /^(\d+)\s+(.+)$/.exec(value);
    if (m) {
      priority = Number(m[1]);
      value = m[2]!;
    }
    value = value.replace(/\.$/, "");
  }
  let purpose: DnsRecordRequirement["purpose"] = PURPOSE[type] ?? "other";
  if (type === "TXT") {
    if (value.startsWith("v=spf1")) purpose = "spf";
    else if (host.includes("._domainkey.")) purpose = "dkim";
    else if (host.startsWith("_dmarc.")) purpose = "dmarc";
  } else if (type === "CNAME" && /autoconfig|autodiscover/.test(host)) purpose = "autoconfig";
  return { type, host, value, purpose, ...(priority !== undefined ? { priority } : {}) };
}
