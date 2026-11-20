import { describe, expect, it } from "vitest";
import { FirestoreStore, decodeFields, encodeFields } from "./firestore";
import { MemoryStore } from "./memory";
import { WriteConflictError, type Store } from "./store";

function fakeFirestore(handler: (url: string, body: unknown) => { status?: number; json: unknown }) {
  const calls: { url: string; method: string; auth: string | null; body: unknown }[] = [];
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      url,
      method: init?.method ?? "GET",
      auth: new Headers(init?.headers).get("authorization"),
      body,
    });
    const r = handler(url, body);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as typeof fetch;
  const store = new FirestoreStore({ projectId: "demo", accessToken: async () => "tok", fetcher });
  return { store, calls };
}

describe("Firestore REST store", () => {
  it("round-trips values through Firestore's typed encoding", () => {
    const data = {
      s: "x",
      i: 42,
      d: 1.5,
      b: true,
      n: null,
      a: [1, "two", { k: false }],
      m: { nested: { deep: [] } },
    };
    const fields = encodeFields({ ...data, skipped: undefined });
    expect(fields.i).toEqual({ integerValue: "42" });
    expect(fields.d).toEqual({ doubleValue: 1.5 });
    expect(fields).not.toHaveProperty("skipped");
    expect(decodeFields(fields)).toEqual(data);
  });

  it("commits atomically with existence preconditions and update masks", async () => {
    const { store, calls } = fakeFirestore(() => ({ json: {} }));
    await store.commit([
      { type: "create", collection: "claims", id: "address:a@b.test", data: { id: "address:a@b.test" } },
      { type: "update", collection: "mailboxes", id: "m1", data: { status: "active", lastError: null } },
      { type: "delete", collection: "sessions", id: "s1" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://firestore.googleapis.com/v1/projects/demo/databases/(default)/documents:commit",
    );
    expect(calls[0]!.auth).toBe("Bearer tok");
    const writes = (calls[0]!.body as { writes: Record<string, unknown>[] }).writes;
    expect(writes[0]).toMatchObject({
      update: { name: "projects/demo/databases/(default)/documents/claims/address:a@b.test" },
      currentDocument: { exists: false },
    });
    expect(writes[1]).toMatchObject({
      updateMask: { fieldPaths: ["status", "lastError"] },
      currentDocument: { exists: true },
    });
    expect(writes[2]).toEqual({ delete: "projects/demo/databases/(default)/documents/sessions/s1" });
  });

  it("maps precondition failures to WriteConflictError and missing documents to null", async () => {
    const { store } = fakeFirestore((url) =>
      url.endsWith(":commit")
        ? { status: 409, json: { error: { status: "ALREADY_EXISTS", message: "exists" } } }
        : { status: 404, json: { error: { status: "NOT_FOUND" } } },
    );
    await expect(
      store.commit([{ type: "create", collection: "claims", id: "x", data: {} }]),
    ).rejects.toBeInstanceOf(WriteConflictError);
    expect(await store.get("users", "nobody")).toBeNull();
  });

  it("builds structured queries and count aggregations", async () => {
    const { store, calls } = fakeFirestore((url) =>
      url.endsWith(":runAggregationQuery")
        ? { json: [{ result: { aggregateFields: { n: { integerValue: "7" } } } }] }
        : { json: [{ document: { fields: { id: { stringValue: "a" } } } }, { readTime: "now" }] },
    );
    expect(
      await store.query("mailboxes", {
        where: [["status", "==", "active"]],
        orderBy: { field: "createdAt", direction: "desc" },
        limit: 5,
      }),
    ).toEqual([{ id: "a" }]);
    expect(calls[0]!.body).toEqual({
      structuredQuery: {
        from: [{ collectionId: "mailboxes" }],
        where: {
          fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "active" } },
        },
        orderBy: [{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }],
        limit: 5,
      },
    });
    expect(
      await store.count("mailSessions", [
        ["expiresAt", ">", 10],
        ["mailboxId", "==", null],
      ]),
    ).toBe(7);
    const agg = calls[1]!.body as {
      structuredAggregationQuery: { structuredQuery: { where: { compositeFilter: { filters: unknown[] } } } };
    };
    expect(agg.structuredAggregationQuery.structuredQuery.where.compositeFilter.filters).toEqual([
      {
        fieldFilter: { field: { fieldPath: "expiresAt" }, op: "GREATER_THAN", value: { integerValue: "10" } },
      },
      { unaryFilter: { field: { fieldPath: "mailboxId" }, op: "IS_NULL" } },
    ]);
  });

  it("refuses path traversal in document ids", async () => {
    const { store } = fakeFirestore(() => ({ json: {} }));
    await expect(store.get("users", "../admin")).rejects.toThrow(/Invalid document id/);
  });
});

describe("memory store", () => {
  const store: () => Store = () => new MemoryStore();

  it("applies a commit entirely or not at all", async () => {
    const s = store();
    await s.commit([{ type: "create", collection: "claims", id: "x", data: { id: "x" } }]);
    await expect(
      s.commit([
        { type: "create", collection: "mailboxes", id: "m", data: { id: "m" } },
        { type: "create", collection: "claims", id: "x", data: { id: "x" } },
      ]),
    ).rejects.toBeInstanceOf(WriteConflictError);
    expect(await s.get("mailboxes", "m")).toBeNull();
    await expect(
      s.commit([{ type: "update", collection: "mailboxes", id: "m", data: { a: 1 } }]),
    ).rejects.toBeInstanceOf(WriteConflictError);
  });

  it("filters, orders, pages and counts", async () => {
    const s = store();
    await s.commit(
      [1, 2, 3, 4].map((n) => ({
        type: "create" as const,
        collection: "logs",
        id: `l${n}`,
        data: { id: `l${n}`, n, even: n % 2 === 0 },
      })),
    );
    expect(
      (
        await s.query<{ n: number }>("logs", {
          orderBy: { field: "n", direction: "desc" },
          limit: 2,
          offset: 1,
        })
      ).map((r) => r.n),
    ).toEqual([3, 2]);
    expect(await s.count("logs", [["even", "==", true]])).toBe(2);
    expect(await s.count("logs", [["n", ">=", 3]])).toBe(2);
  });
});
