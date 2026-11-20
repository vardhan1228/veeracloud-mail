import {
  WriteConflictError,
  clean,
  type Data,
  type Filter,
  type QueryOptions,
  type Store,
  type Write,
} from "./store";

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  return (a as number | string) < (b as number | string) ? -1 : 1;
}

function matches(doc: Data, [field, op, value]: Filter): boolean {
  const v = doc[field];
  switch (op) {
    case "==":
      return v === value;
    case "!=":
      return v !== value;
    case "<":
      return v !== null && v !== undefined && compare(v, value) < 0;
    case "<=":
      return v !== null && v !== undefined && compare(v, value) <= 0;
    case ">":
      return v !== null && v !== undefined && compare(v, value) > 0;
    case ">=":
      return v !== null && v !== undefined && compare(v, value) >= 0;
  }
}

/**
 * In-memory Store with the same semantics as FirestoreStore (atomic commits, preconditions).
 * Used by tests and by `wrangler dev` when no Firebase service account is configured.
 * Data lives only as long as the process.
 */
export class MemoryStore implements Store {
  private readonly data = new Map<string, Map<string, Data>>();

  private col(name: string) {
    let c = this.data.get(name);
    if (!c) this.data.set(name, (c = new Map()));
    return c;
  }

  async get<T = Data>(collection: string, id: string): Promise<T | null> {
    const doc = this.col(collection).get(id);
    return doc ? (structuredClone(doc) as T) : null;
  }

  async query<T = Data>(collection: string, options: QueryOptions = {}): Promise<T[]> {
    let rows = [...this.col(collection).values()].filter((d) =>
      (options.where ?? []).every((f) => matches(d, f)),
    );
    if (options.orderBy) {
      const { field, direction = "asc" } = options.orderBy;
      rows = rows
        .filter((d) => d[field] !== undefined)
        .sort((a, b) => compare(a[field], b[field]) * (direction === "desc" ? -1 : 1));
    }
    const start = options.offset ?? 0;
    rows = rows.slice(start, options.limit !== undefined ? start + options.limit : undefined);
    return rows.map((d) => structuredClone(d) as T);
  }

  async count(collection: string, where: Filter[] = []): Promise<number> {
    return [...this.col(collection).values()].filter((d) => where.every((f) => matches(d, f))).length;
  }

  async commit(writes: Write[]): Promise<void> {
    if (writes.length > 500) throw new Error("A commit can hold at most 500 writes");
    // Validate every precondition against the state as it would be mid-commit, then apply.
    const staged = new Map<string, Data | null>();
    const key = (w: Write) => `${w.collection}\u0000${w.id}`;
    const current = (w: Write) =>
      staged.has(key(w)) ? staged.get(key(w))! : (this.col(w.collection).get(w.id) ?? null);
    for (const w of writes) {
      const existing = current(w);
      switch (w.type) {
        case "create":
          if (existing) throw new WriteConflictError(`${w.collection}/${w.id} already exists`);
          staged.set(key(w), clean(w.data));
          break;
        case "set":
          staged.set(key(w), clean(w.data));
          break;
        case "update":
          if (!existing) throw new WriteConflictError(`${w.collection}/${w.id} does not exist`);
          staged.set(key(w), { ...existing, ...clean(w.data) });
          break;
        case "delete":
          staged.set(key(w), null);
          break;
      }
    }
    for (const [k, doc] of staged) {
      const [collection, id] = k.split("\u0000") as [string, string];
      if (doc === null) this.col(collection).delete(id);
      else this.col(collection).set(id, structuredClone(doc));
    }
  }

  /** Test helper: every document, for asserting that secrets never reach storage. */
  dump(): Record<string, Data[]> {
    return Object.fromEntries([...this.data].map(([name, c]) => [name, [...c.values()]]));
  }
}
