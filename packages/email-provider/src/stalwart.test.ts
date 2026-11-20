import { describe, expect, it } from "vitest";
import { JmapClient } from "./stalwart/jmap";
import { StalwartAdmin, parseRecord } from "./stalwart/admin";
import { createEmailProvider } from "./factory";
import { ProviderNotConfiguredError, ProviderRequestError } from "./types";

type Call = { url: string; method: string; auth: string | null; body: unknown };

/** Fake Stalwart: records requests and answers from a handler. */
function fakeServer(handler: (call: Call) => unknown, status = 200) {
  const calls: Call[] = [];
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const raw = init?.body;
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      auth: headers.get("authorization"),
      body: typeof raw === "string" ? JSON.parse(raw) : raw,
    };
    calls.push(call);
    const out = handler(call);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetcher };
}

const SESSION = {
  apiUrl: "https://mail.test/jmap/",
  uploadUrl: "https://mail.test/jmap/upload/{accountId}/",
  downloadUrl: "https://mail.test/jmap/download/{accountId}/{blobId}/{name}?accept={type}",
  primaryAccounts: { "urn:ietf:params:jmap:mail": "acc1" },
};

describe("Stalwart management API adapter", () => {
  it("creates mailboxes with the full address as principal and unlimited quota as 0", async () => {
    const { calls, fetcher } = fakeServer(() => ({ data: 7 }));
    const admin = new StalwartAdmin({
      baseUrl: "https://mail.test/",
      adminUser: "admin",
      adminPassword: "pw",
      fetcher,
    });
    await admin.createMailbox({
      address: "priya@acme.test",
      displayName: "Priya",
      quotaMb: null,
      password: "secret pw 123",
    });
    expect(calls[0]).toMatchObject({
      url: "https://mail.test/api/principal",
      method: "POST",
      auth: `Basic ${btoa("admin:pw")}`,
      body: {
        type: "individual",
        name: "priya@acme.test",
        emails: ["priya@acme.test"],
        quota: 0,
        secrets: ["secret pw 123"],
      },
    });
  });

  it("maps disable, password and alias changes to PATCH operations", async () => {
    const { calls, fetcher } = fakeServer(() => ({ data: null }));
    const admin = new StalwartAdmin({
      baseUrl: "https://mail.test",
      adminUser: "a",
      adminPassword: "b",
      fetcher,
    });
    await admin.updateMailbox("priya@acme.test", { enabled: false, password: "n", quotaMb: 1024 });
    expect(calls[0]!.url).toBe("https://mail.test/api/principal/priya%40acme.test");
    expect(calls[0]!.body).toEqual([
      { action: "set", field: "quota", value: 1024 * 1024 * 1024 },
      { action: "set", field: "secrets", value: ["n"] },
      { action: "addItem", field: "disabledPermissions", value: "authenticate" },
    ]);
    await admin.addAlias("priya@acme.test", "sales@acme.test");
    expect(calls[1]!.body).toEqual([{ action: "addItem", field: "emails", value: "sales@acme.test" }]);
  });

  it("surfaces server errors as ProviderRequestError", async () => {
    const { fetcher } = fakeServer(() => ({ error: "fieldAlreadyExists", details: "priya@acme.test" }), 400);
    const admin = new StalwartAdmin({
      baseUrl: "https://mail.test",
      adminUser: "a",
      adminPassword: "b",
      fetcher,
    });
    await expect(admin.deleteMailbox("x")).rejects.toBeInstanceOf(ProviderRequestError);
  });

  it("parses DNS records Stalwart publishes", () => {
    expect(parseRecord({ type: "MX", name: "acme.test.", content: "10 mail.acme.test." })).toEqual({
      type: "MX",
      host: "acme.test",
      value: "mail.acme.test",
      priority: 10,
      purpose: "mx",
    });
    expect(parseRecord({ type: "TXT", name: "acme.test.", content: "v=spf1 mx -all" }).purpose).toBe("spf");
    expect(
      parseRecord({ type: "TXT", name: "abc._domainkey.acme.test.", content: "v=DKIM1; k=ed25519; p=x" })
        .purpose,
    ).toBe("dkim");
    expect(
      parseRecord({ type: "TXT", name: "_dmarc.acme.test.", content: "v=DMARC1; p=reject" }).purpose,
    ).toBe("dmarc");
  });
});

describe("JMAP client", () => {
  it("returns null for rejected credentials", async () => {
    const { fetcher } = fakeServer(() => new Response("", { status: 401 }));
    expect(await JmapClient.connect("https://mail.test", "a@acme.test", "bad", fetcher)).toBeNull();
  });

  it("lists a folder with a back-referenced Email/get", async () => {
    const { calls, fetcher } = fakeServer((call) => {
      if (call.url.endsWith("/.well-known/jmap")) return SESSION;
      const req = call.body as { methodCalls: [string, Record<string, unknown>, string][] };
      if (req.methodCalls[0]![0] === "Mailbox/get") {
        return {
          methodResponses: [
            [
              "Mailbox/get",
              {
                list: [
                  {
                    id: "mb-in",
                    name: "Inbox",
                    role: "inbox",
                    totalEmails: 1,
                    unreadEmails: 1,
                    sortOrder: 0,
                  },
                ],
              },
              "m",
            ],
          ],
        };
      }
      return {
        methodResponses: [
          ["Email/query", { total: 1, ids: ["e1"] }, "q"],
          [
            "Email/get",
            {
              list: [
                {
                  id: "e1",
                  mailboxIds: { "mb-in": true },
                  keywords: { $seen: true },
                  from: [{ name: "Ravi", email: "ravi@acme.test" }],
                  to: [],
                  subject: "Hi",
                  preview: "hello",
                  receivedAt: "2026-11-20T10:00:00Z",
                  hasAttachment: false,
                },
              ],
            },
            "g",
          ],
        ],
      };
    });
    const client = (await JmapClient.connect("https://mail.test", "priya@acme.test", "pw", fetcher))!;
    const res = await client.list({ folderId: "inbox", limit: 20, offset: 0 });
    expect(res.total).toBe(1);
    expect(res.messages[0]).toMatchObject({
      id: "e1",
      seen: true,
      subject: "Hi",
      receivedAt: Date.parse("2026-11-20T10:00:00Z"),
    });
    const query = (calls[2]!.body as { methodCalls: [string, Record<string, unknown>, string][] })
      .methodCalls;
    expect(query[0]![1]).toMatchObject({
      accountId: "acc1",
      filter: { inMailbox: "mb-in" },
      calculateTotal: true,
    });
    expect(query[1]![1]["#ids"]).toEqual({ resultOf: "q", name: "Email/query", path: "/ids" });
    expect(calls.every((c) => c.auth === `Basic ${btoa("priya@acme.test:pw")}`)).toBe(true);
  });

  it("sends via EmailSubmission and moves the message from Drafts to Sent", async () => {
    const { calls, fetcher } = fakeServer((call) => {
      if (call.url.endsWith("/.well-known/jmap")) return SESSION;
      const req = call.body as { methodCalls: [string, Record<string, unknown>, string][] };
      const name = req.methodCalls[0]![0];
      if (name === "Mailbox/get") {
        return {
          methodResponses: [
            [
              "Mailbox/get",
              {
                list: [
                  { id: "d", name: "Drafts", role: "drafts", totalEmails: 0, unreadEmails: 0, sortOrder: 1 },
                  { id: "s", name: "Sent", role: "sent", totalEmails: 0, unreadEmails: 0, sortOrder: 2 },
                ],
              },
              "m",
            ],
          ],
        };
      }
      if (name === "Identity/get")
        return {
          methodResponses: [["Identity/get", { list: [{ id: "id1", email: "priya@acme.test" }] }, "i"]],
        };
      return {
        methodResponses: [
          ["Email/set", { created: { draft: { id: "new1" } } }, "e"],
          ["EmailSubmission/set", { created: { sub: { id: "sub1" } } }, "s"],
        ],
      };
    });
    const client = (await JmapClient.connect("https://mail.test", "priya@acme.test", "pw", fetcher))!;
    const result = await client.send({
      from: { name: "Priya", email: "priya@acme.test" },
      to: ["ravi@acme.test"],
      cc: [],
      bcc: [],
      subject: "Hello",
      text: "Body",
      attachments: [],
    });
    expect(result).toEqual({ id: "new1", undelivered: [] });
    const last = (calls.at(-1)!.body as { methodCalls: [string, Record<string, unknown>, string][] })
      .methodCalls;
    expect(last[0]![1]).toMatchObject({ create: { draft: { mailboxIds: { d: true }, subject: "Hello" } } });
    expect(last[1]![1]).toMatchObject({
      create: { sub: { identityId: "id1", emailId: "#draft" } },
      onSuccessUpdateEmail: {
        "#sub": { "mailboxIds/d": null, "mailboxIds/s": true, "keywords/$draft": null },
      },
    });
  });
});

describe("JMAP push", () => {
  it("turns the server's EventSource stream into change and ping events", async () => {
    const sse = [
      "event: ping",
      "data: {}",
      "",
      ": comment",
      "",
      "event: state",
      'data: {"changed":{}}',
      "",
      "",
    ].join("\n");
    const { calls, fetcher } = fakeServer((call) =>
      call.url.includes("/.well-known/jmap")
        ? {
            ...SESSION,
            eventSourceUrl:
              "https://mail.test/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}",
          }
        : new Response(sse, { headers: { "content-type": "text/event-stream" } }),
    );
    const client = (await JmapClient.connect("https://mail.test", "a@b.test", "pw", fetcher))!;
    const events: string[] = [];
    for await (const e of client.watch(new AbortController().signal)) events.push(e);
    expect(events).toEqual(["ping", "change"]);
    expect(calls[1]!.url).toBe(
      "https://mail.test/jmap/eventsource/?types=Email,Mailbox&closeafter=no&ping=30",
    );
    expect(calls[1]!.auth).toMatch(/^Basic /);
  });
});

describe("createEmailProvider", () => {
  const db = {} as never;
  it("reports setup-required when nothing or an incomplete Stalwart config is set", () => {
    expect(() => createEmailProvider({ environment: "development", provider: undefined, db })).toThrow(
      ProviderNotConfiguredError,
    );
    expect(() =>
      createEmailProvider({
        environment: "production",
        provider: "stalwart",
        db,
        stalwart: { baseUrl: "https://m.test" },
      }),
    ).toThrow(ProviderNotConfiguredError);
  });

  it("refuses the mock and plain-http Stalwart in production", () => {
    expect(() => createEmailProvider({ environment: "production", provider: "mock", db })).toThrow(
      ProviderNotConfiguredError,
    );
    expect(() =>
      createEmailProvider({
        environment: "production",
        provider: "stalwart",
        db,
        stalwart: { baseUrl: "http://m.test", adminUser: "a", adminPassword: "b" },
      }),
    ).toThrow(/https/);
    expect(
      createEmailProvider({
        environment: "production",
        provider: "stalwart",
        db,
        stalwart: { baseUrl: "https://m.test", adminUser: "a", adminPassword: "b" },
      }).key,
    ).toBe("stalwart");
  });
});
