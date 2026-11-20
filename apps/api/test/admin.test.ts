import { describe, expect, it } from "vitest";
import { C } from "@havins/database";
import { ProviderRequestError } from "@havins/email-provider";
import { PASSWORD, createHarness, json, setupMailbox } from "./helpers";

describe("admin: domains and mailboxes", () => {
  it("adds a domain on the mail server and shows the DNS records it returns", async () => {
    const h = createHarness();
    const cookie = await h.admin();
    const res = await h.request("POST", "/admin/domains", { cookie, body: { name: "Acme.Test" } });
    expect(res.status).toBe(201);
    const body = await json<{
      domain: { name: string; mailReady: boolean; records: unknown[] };
      providerStatus: string;
    }>(res);
    expect(body).toMatchObject({ providerStatus: "ready", domain: { name: "acme.test", mailReady: true } });
    expect(body.domain.records.length).toBeGreaterThan(0);
    expect(
      await json(await h.request("POST", "/admin/domains", { cookie, body: { name: "acme.test" } })),
    ).toMatchObject({
      code: "domain_exists",
    });
  });

  it("keeps the domain but reports setup-required when no mail server is connected", async () => {
    const h = createHarness();
    const cookie = await h.admin();
    h.setProviderConfigured(false);
    const res = await json<{ domain: { id: string; mailReady: boolean }; providerStatus: string }>(
      await h.request("POST", "/admin/domains", { cookie, body: { name: "acme.test" } }),
    );
    expect(res).toMatchObject({ providerStatus: "not_configured", domain: { mailReady: false } });
    h.setProviderConfigured(true);
    const retry = await h.request("POST", `/admin/domains/${res.domain.id}/provision`, { cookie });
    expect(await json(retry)).toMatchObject({ providerStatus: "ready", domain: { mailReady: true } });
  });

  it("creates unlimited mailboxes without storing the password", async () => {
    const h = createHarness();
    const cookie = await h.admin();
    for (let i = 0; i < 30; i++) await setupMailbox(h, cookie, `staff${i}`);
    const list = await json<{ mailboxes: { status: string; quotaMb: number | null }[] }>(
      await h.request("GET", "/admin/mailboxes", { cookie }),
    );
    expect(list.mailboxes).toHaveLength(30);
    expect(list.mailboxes.every((m) => m.status === "active" && m.quotaMb === null)).toBe(true);

    const stored = JSON.stringify(h.db.dump());
    expect(stored).not.toContain(PASSWORD);
    // The (development) mail server only holds a salted hash.
    const [acct] = await h.db.query<{ passwordHash: string }>(C.mockAccounts);
    expect(acct!.passwordHash).toMatch(/^pbkdf2\$/);
  });

  it("rejects duplicate addresses and weak passwords", async () => {
    const h = createHarness();
    const cookie = await h.admin();
    const { domainId } = await setupMailbox(h, cookie, "priya");
    const dup = await h.request("POST", "/admin/mailboxes", {
      cookie,
      body: { domainId, localPart: "priya", displayName: "P", password: PASSWORD },
    });
    expect(await json(dup)).toMatchObject({ code: "address_taken" });
    const weak = await h.request("POST", "/admin/mailboxes", {
      cookie,
      body: { domainId, localPart: "x", displayName: "X", password: "short" },
    });
    expect(weak.status).toBe(400);
  });

  it("records mail server failures honestly and allows a retry", async () => {
    const h = createHarness();
    const cookie = await h.admin();
    const { domainId } = await setupMailbox(h, cookie, "first");
    h.provider.admin.createMailbox = (() => {
      throw new ProviderRequestError("Upstream timeout", true);
    }) as never;
    const body = { domainId, localPart: "ops", displayName: "Ops", password: PASSWORD };
    const failed = await h.request("POST", "/admin/mailboxes", { cookie, body });
    expect(failed.status).toBe(503);
    const list = await json<{ mailboxes: { address: string; status: string }[] }>(
      await h.request("GET", "/admin/mailboxes", { cookie }),
    );
    expect(list.mailboxes.find((m) => m.address === "ops@acme.test")).toMatchObject({ status: "failed" });

    // Restore the real implementation (the override was an own property shadowing the prototype).
    delete (h.provider.admin as unknown as Record<string, unknown>).createMailbox;
    expect((await h.request("POST", "/admin/mailboxes", { cookie, body })).status).toBe(201);
  });

  it("disabling a mailbox or resetting its password signs the employee out", async () => {
    const h = createHarness();
    const cookie = await h.admin();
    const { mailboxId, address } = await setupMailbox(h, cookie, "priya");
    const mail = await h.mailLogin(address);
    expect((await h.request("GET", "/mail/me", { cookie: mail })).status).toBe(200);

    await h.request("POST", `/admin/mailboxes/${mailboxId}/password`, {
      cookie,
      body: { password: "a brand new passphrase" },
    });
    expect((await h.request("GET", "/mail/me", { cookie: mail })).status).toBe(401);
    await expect(h.mailLogin(address)).rejects.toThrow(/401/);
    const again = await h.mailLogin(address, "a brand new passphrase");

    await h.request("PATCH", `/admin/mailboxes/${mailboxId}`, { cookie, body: { enabled: false } });
    expect((await h.request("GET", "/mail/me", { cookie: again })).status).toBe(401);
    await expect(h.mailLogin(address, "a brand new passphrase")).rejects.toThrow(/401/);
  });

  it("manages aliases and refuses to delete a domain that still has mailboxes", async () => {
    const h = createHarness();
    const cookie = await h.admin();
    const { domainId, mailboxId } = await setupMailbox(h, cookie, "info");
    const alias = await h.request("POST", "/admin/aliases", {
      cookie,
      body: { domainId, localPart: "sales", destinationMailboxId: mailboxId },
    });
    expect(alias.status).toBe(201);
    const clash = await h.request("POST", "/admin/aliases", {
      cookie,
      body: { domainId, localPart: "info", destinationMailboxId: mailboxId },
    });
    expect(await json(clash)).toMatchObject({ code: "address_taken" });
    expect(await json(await h.request("DELETE", `/admin/domains/${domainId}`, { cookie }))).toMatchObject({
      code: "domain_in_use",
    });
    expect((await h.request("DELETE", `/admin/mailboxes/${mailboxId}`, { cookie })).status).toBe(200);
    expect((await h.request("DELETE", `/admin/domains/${domainId}`, { cookie })).status).toBe(200);
  });
});
