import { describe, expect, it } from "vitest";
import { C } from "@havins/database";
import { PASSWORD, createHarness, json, setupMailbox } from "./helpers";

async function twoEmployees() {
  const h = createHarness();
  const admin = await h.admin();
  const priya = await setupMailbox(h, admin, "priya");
  const ravi = await setupMailbox(h, admin, "ravi");
  return { h, admin, priya, ravi, p: await h.mailLogin(priya.address), r: await h.mailLogin(ravi.address) };
}

interface Listing {
  total: number;
  messages: { id: string; subject: string; seen: boolean; hasAttachment: boolean }[];
}

describe("employee webmail", () => {
  it("signs in with the mailbox password, with one generic error for every failure", async () => {
    const h = createHarness();
    const admin = await h.admin();
    const { address } = await setupMailbox(h, admin, "priya");
    const res = await h.request("POST", "/mail/login", { body: { address, password: PASSWORD } });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/^__Host-mail=.*HttpOnly/i);

    const wrong = await json(await h.request("POST", "/mail/login", { body: { address, password: "nope" } }));
    const unknown = await json(
      await h.request("POST", "/mail/login", { body: { address: "ghost@acme.test", password: PASSWORD } }),
    );
    expect(wrong).toMatchObject({ code: "invalid_credentials" });
    expect(unknown).toEqual(wrong);
    expect((await h.request("GET", "/mail/folders")).status).toBe(401);
  });

  it("stores the session credential encrypted, never in plain text", async () => {
    const { h } = await twoEmployees();
    const mailRows = await h.db.query<{ credential: string }>(C.mailSessions);
    expect(mailRows).toHaveLength(2);
    for (const r of mailRows) {
      expect(r.credential).toBeTruthy();
      expect(r.credential).not.toContain(PASSWORD);
    }
  });

  it("rate-limits repeated login attempts", async () => {
    const h = createHarness();
    const admin = await h.admin();
    const { address } = await setupMailbox(h, admin, "priya");
    h.setRateLimit(3);
    for (let i = 0; i < 3; i++)
      await h.request("POST", "/mail/login", { body: { address, password: "bad" } });
    const blocked = await h.request("POST", "/mail/login", { body: { address, password: PASSWORD } });
    expect(blocked.status).toBe(429);
  });

  it("delivers internal mail, threads replies and tracks read state", async () => {
    const { h, priya, ravi, p, r } = await twoEmployees();
    const sent = await h.request("POST", "/mail/send", {
      cookie: p,
      body: { to: [ravi.address], subject: "Quarterly plan", text: "Draft attached soon." },
    });
    expect(sent.status).toBe(200);
    expect(await json(sent)).toMatchObject({ undelivered: [] });

    const inbox = await json<Listing>(await h.request("GET", "/mail/messages?folder=inbox", { cookie: r }));
    expect(inbox.total).toBe(1);
    expect(inbox.messages[0]).toMatchObject({ subject: "Quarterly plan", seen: false });
    const id = inbox.messages[0]!.id;

    const folders = await json<{ folders: { role: string; unread: number }[] }>(
      await h.request("GET", "/mail/folders", { cookie: r }),
    );
    expect(folders.folders.find((f) => f.role === "inbox")!.unread).toBe(1);

    await h.request("PATCH", `/mail/messages/${id}`, { cookie: r, body: { seen: true } });
    const msg = await json<{ message: { seen: boolean; text: string; from: { email: string }[] } }>(
      await h.request("GET", `/mail/messages/${id}`, { cookie: r }),
    );
    expect(msg.message).toMatchObject({
      seen: true,
      text: "Draft attached soon.",
      from: [{ email: priya.address }],
    });

    const reply = await h.request("POST", "/mail/send", {
      cookie: r,
      body: { to: [priya.address], subject: "Re: Quarterly plan", text: "Thanks", inReplyToId: id },
    });
    expect(reply.status).toBe(200);
    const sentFolder = await json<Listing>(
      await h.request("GET", "/mail/messages?folder=sent", { cookie: p }),
    );
    expect(sentFolder.total).toBe(1);
  });

  it("isolates mailboxes: an employee cannot read or change a colleague's message", async () => {
    const { h, ravi, p, r } = await twoEmployees();
    await h.request("POST", "/mail/send", {
      cookie: p,
      body: { to: [ravi.address], subject: "Private", text: "x" },
    });
    const { messages } = await json<Listing>(
      await h.request("GET", "/mail/messages?folder=inbox", { cookie: r }),
    );
    const id = messages[0]!.id;
    expect((await h.request("GET", `/mail/messages/${id}`, { cookie: p })).status).toBe(404);
    await h.request("DELETE", `/mail/messages/${id}`, { cookie: p });
    expect((await h.request("GET", `/mail/messages/${id}`, { cookie: r })).status).toBe(200);
  });

  it("reports outside recipients as undelivered on the development server", async () => {
    const { h, p } = await twoEmployees();
    const res = await json(
      await h.request("POST", "/mail/send", {
        cookie: p,
        body: { to: ["someone@gmail.com"], subject: "Hi", text: "x" },
      }),
    );
    expect(res).toMatchObject({ undelivered: ["someone@gmail.com"] });
  });

  it("uploads, sends and downloads attachments only for the owner", async () => {
    const { h, ravi, p, r } = await twoEmployees();
    const data = new TextEncoder().encode("hello,world\n1,2\n");
    const up = await h.request("POST", "/mail/attachments", {
      cookie: p,
      raw: { data, type: "text/csv", filename: "numbers.csv" },
    });
    expect(up.status).toBe(201);
    const blob = await json<{ blobId: string; name: string; size: number; type: string }>(up);
    expect(blob).toMatchObject({ name: "numbers.csv", size: data.byteLength });

    // Ravi cannot fetch Priya's uploaded blob directly.
    expect((await h.request("GET", `/mail/attachments/${blob.blobId}`, { cookie: r })).status).toBe(404);

    await h.request("POST", "/mail/send", {
      cookie: p,
      body: { to: [ravi.address], subject: "Numbers", text: "See file", attachments: [blob] },
    });
    const { messages } = await json<Listing>(
      await h.request("GET", "/mail/messages?folder=inbox", { cookie: r }),
    );
    expect(messages[0]!.hasAttachment).toBe(true);
    const full = await json<{ message: { attachments: { blobId: string }[] } }>(
      await h.request("GET", `/mail/messages/${messages[0]!.id}`, { cookie: r }),
    );
    const dl = await h.request(
      "GET",
      `/mail/attachments/${full.message.attachments[0]!.blobId}?name=numbers.csv`,
      {
        cookie: r,
      },
    );
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(dl.headers.get("content-type")).toBe("application/octet-stream");
    expect(await dl.text()).toBe("hello,world\n1,2\n");
  });

  it("moves to junk and trash, searches, saves drafts and suggests colleagues", async () => {
    const { h, ravi, p, r } = await twoEmployees();
    await h.request("POST", "/mail/send", {
      cookie: p,
      body: { to: [ravi.address], subject: "Lottery win", text: "spam" },
    });
    await h.request("POST", "/mail/send", {
      cookie: p,
      body: { to: [ravi.address], subject: "Invoice 42", text: "real" },
    });
    const search = await json<Listing>(
      await h.request("GET", "/mail/messages?folder=inbox&q=Invoice", { cookie: r }),
    );
    expect(search.messages.map((m) => m.subject)).toEqual(["Invoice 42"]);

    const all = await json<Listing>(await h.request("GET", "/mail/messages?folder=inbox", { cookie: r }));
    const spam = all.messages.find((m) => m.subject === "Lottery win")!;
    await h.request("PATCH", `/mail/messages/${spam.id}`, { cookie: r, body: { folder: "junk" } });
    const junk = await json<Listing>(await h.request("GET", "/mail/messages?folder=junk", { cookie: r }));
    expect(junk.total).toBe(1);

    const draft = await json<{ id: string }>(
      await h.request("POST", "/mail/drafts", {
        cookie: p,
        body: { to: [], subject: "Half done", text: "..." },
      }),
    );
    const drafts = await json<Listing>(await h.request("GET", "/mail/messages?folder=drafts", { cookie: p }));
    expect(drafts.messages.map((m) => m.id)).toEqual([draft.id]);

    const contacts = await json<{ contacts: { email: string }[] }>(
      await h.request("GET", "/mail/contacts?q=ravi", { cookie: p }),
    );
    expect(contacts.contacts.map((c) => c.email)).toContain(ravi.address);
  });

  it("changes the password, keeping this session and ending others", async () => {
    const { h, priya, p } = await twoEmployees();
    const other = await h.mailLogin(priya.address);
    const wrong = await h.request("POST", "/mail/password", {
      cookie: p,
      body: { currentPassword: "nope", newPassword: "another long passphrase" },
    });
    expect(wrong.status).toBe(400);
    const ok = await h.request("POST", "/mail/password", {
      cookie: p,
      body: { currentPassword: PASSWORD, newPassword: "another long passphrase" },
    });
    expect(ok.status).toBe(200);
    expect((await h.request("GET", "/mail/me", { cookie: p })).status).toBe(200);
    expect((await h.request("GET", "/mail/me", { cookie: other })).status).toBe(401);
    await h.mailLogin(priya.address, "another long passphrase");
  });

  it("shows setup-required when no mail server is connected", async () => {
    const h = createHarness();
    h.setProviderConfigured(false);
    const res = await h.request("POST", "/mail/login", { body: { address: "a@acme.test", password: "x" } });
    // Unknown mailbox short-circuits before touching the provider: still the generic error.
    expect(res.status).toBe(401);
    const cookie = await h.admin();
    const create = await h.request("POST", "/admin/domains", { cookie, body: { name: "acme.test" } });
    expect(await json(create)).toMatchObject({ providerStatus: "not_configured" });
  });

  it("pushes a live change event when new mail arrives", async () => {
    const { h, ravi, p, r } = await twoEmployees();
    const res = await h.request("GET", "/mail/events", { cookie: r });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const until = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream ended before ${needle}`);
        text += decoder.decode(value);
      }
    };
    await until("event: ready");
    await h.request("POST", "/mail/send", {
      cookie: p,
      body: { to: [ravi.address], subject: "Live", text: "now" },
    });
    await until("event: change");
    await reader.cancel();
    expect((await h.request("GET", "/mail/events")).status).toBe(401);
  });
});
