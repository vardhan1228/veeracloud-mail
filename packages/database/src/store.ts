/**
 * Minimal document-store contract the API is written against. Production uses Firebase
 * Firestore (firestore.ts); tests and quick local runs use MemoryStore (memory.ts).
 *
 * Design rules that keep Firestore cheap and index-free:
 * - Look documents up by id wherever possible (sessions by token hash, users by Firebase uid).
 * - Queries use equality filters, or one range filter, on a single field. Sorting of small
 *   collections (domains, mailboxes, aliases) happens in the API, not in the query.
 * - Uniqueness (email addresses, domain names) is enforced with "claim" documents created
 *   in the same atomic commit as the record they protect.
 */

/** Any JSON-like value. `undefined` fields are dropped on write. */
export type Data = Record<string, unknown>;

export type FilterOp = "==" | "!=" | "<" | "<=" | ">" | ">=";
export type Filter = [field: string, op: FilterOp, value: unknown];

export interface QueryOptions {
  where?: Filter[];
  orderBy?: { field: string; direction?: "asc" | "desc" };
  limit?: number;
  offset?: number;
}

export type Write =
  /** Fails the whole commit if the document already exists. */
  | { type: "create"; collection: string; id: string; data: Data }
  /** Creates or replaces. */
  | { type: "set"; collection: string; id: string; data: Data }
  /** Merges the given fields. Fails the whole commit if the document does not exist. */
  | { type: "update"; collection: string; id: string; data: Data }
  | { type: "delete"; collection: string; id: string };

export interface Store {
  get<T = Data>(collection: string, id: string): Promise<T | null>;
  query<T = Data>(collection: string, options?: QueryOptions): Promise<T[]>;
  count(collection: string, where?: Filter[]): Promise<number>;
  /** Applies every write atomically, or none of them. At most 500 writes. */
  commit(writes: Write[]): Promise<void>;
}

/** A create hit an existing document, or an update hit a missing one. Nothing was written. */
export class WriteConflictError extends Error {
  constructor(message = "The data changed while saving. Please try again.") {
    super(message);
    this.name = "WriteConflictError";
  }
}

/** The database could not be reached or rejected the request. */
export class StoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreUnavailableError";
  }
}

/** Drops undefined values recursively so both stores see identical data. */
export function clean<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clean) as T;
  if (value && typeof value === "object") {
    const out: Data = {};
    for (const [k, v] of Object.entries(value as Data)) if (v !== undefined) out[k] = clean(v);
    return out as T;
  }
  return value;
}
