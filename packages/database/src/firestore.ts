import { SignJWT, importPKCS8 } from "jose";
import {
  StoreUnavailableError,
  WriteConflictError,
  clean,
  type Data,
  type Filter,
  type FilterOp,
  type QueryOptions,
  type Store,
  type Write,
} from "./store";

/**
 * Firebase Firestore over its REST API, authenticated as a service account. Works in
 * Cloudflare Workers (no gRPC, no Node SDK). Only the Worker talks to Firestore: the
 * security rules in firestore.rules deny all browser access.
 */

export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

export interface FirestoreOptions {
  projectId: string;
  /** Required unless `emulatorHost` or `accessToken` is given. */
  serviceAccount?: ServiceAccount;
  /** "localhost:8080": talks to the Firestore emulator without auth (development only). */
  emulatorHost?: string;
  /** Overrides token minting (tests). */
  accessToken?: () => Promise<string>;
  databaseId?: string;
  fetcher?: typeof fetch;
}

export function parseServiceAccount(json: string | undefined): ServiceAccount | undefined {
  if (!json) return undefined;
  let sa: Partial<ServiceAccount>;
  try {
    sa = JSON.parse(json) as Partial<ServiceAccount>;
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON (paste the whole key file)");
  }
  if (!sa.project_id || !sa.client_email || !sa.private_key) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT must contain project_id, client_email and private_key");
  }
  return sa as ServiceAccount;
}

// ---------- Value encoding (https://firebase.google.com/docs/firestore/reference/rest/v1/Value) ----------

type FsValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { stringValue: string }
  | { arrayValue: { values?: FsValue[] } }
  | { mapValue: { fields?: Record<string, FsValue> } }
  | { timestampValue: string };

export function encodeValue(v: unknown): FsValue {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number")
    return Number.isSafeInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === "object") return { mapValue: { fields: encodeFields(v as Data) } };
  throw new Error(`Cannot store value of type ${typeof v}`);
}

export function encodeFields(data: Data): Record<string, FsValue> {
  const out: Record<string, FsValue> = {};
  for (const [k, v] of Object.entries(data)) if (v !== undefined) out[k] = encodeValue(v);
  return out;
}

export function decodeValue(v: FsValue): unknown {
  if ("nullValue" in v) return null;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("stringValue" in v) return v.stringValue;
  if ("timestampValue" in v) return Date.parse(v.timestampValue);
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(decodeValue);
  if ("mapValue" in v) return decodeFields(v.mapValue.fields ?? {});
  return null;
}

export function decodeFields(fields: Record<string, FsValue>): Data {
  const out: Data = {};
  for (const [k, v] of Object.entries(fields)) out[k] = decodeValue(v);
  return out;
}

const OPS: Record<FilterOp, string> = {
  "==": "EQUAL",
  "!=": "NOT_EQUAL",
  "<": "LESS_THAN",
  "<=": "LESS_THAN_OR_EQUAL",
  ">": "GREATER_THAN",
  ">=": "GREATER_THAN_OR_EQUAL",
};

function whereClause(where: Filter[]) {
  const filters = where.map(([field, op, value]) =>
    value === null && (op === "==" || op === "!=")
      ? { unaryFilter: { field: { fieldPath: field }, op: op === "==" ? "IS_NULL" : "IS_NOT_NULL" } }
      : { fieldFilter: { field: { fieldPath: field }, op: OPS[op], value: encodeValue(value) } },
  );
  if (filters.length === 0) return undefined;
  if (filters.length === 1) return filters[0];
  return { compositeFilter: { op: "AND", filters } };
}

// ---------- Access tokens ----------

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/datastore";
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function mintToken(sa: ServiceAccount, fetcher: typeof fetch): Promise<string> {
  const cached = tokenCache.get(sa.client_email);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const nowSec = Math.floor(Date.now() / 1000);
  const key = await importPKCS8(sa.private_key, "RS256");
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(sa.client_email)
    .setSubject(sa.client_email)
    .setAudience(TOKEN_URL)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + 3600)
    .sign(key);
  let res: Response;
  try {
    res = await fetcher(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    });
  } catch {
    throw new StoreUnavailableError("Cannot reach Google to authenticate the database connection");
  }
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new StoreUnavailableError(
      `Firestore authentication failed: ${body.error_description ?? res.status}`,
    );
  }
  tokenCache.set(sa.client_email, {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  });
  return body.access_token;
}

// ---------- Store ----------

export class FirestoreStore implements Store {
  private readonly root: string;
  private readonly base: string;
  private readonly fetcher: typeof fetch;
  private readonly token: () => Promise<string | null>;

  constructor(options: FirestoreOptions) {
    const db = options.databaseId ?? "(default)";
    this.root = `projects/${options.projectId}/databases/${db}/documents`;
    this.base = options.emulatorHost
      ? `http://${options.emulatorHost}/v1/${this.root}`
      : `https://firestore.googleapis.com/v1/${this.root}`;
    this.fetcher = options.fetcher ?? ((...args) => fetch(...args));
    const fetcher = this.fetcher;
    if (options.accessToken) this.token = options.accessToken;
    else if (options.emulatorHost) this.token = async () => "owner";
    else if (options.serviceAccount) {
      const sa = options.serviceAccount;
      this.token = () => mintToken(sa, fetcher);
    } else throw new Error("FirestoreStore needs a service account, an emulator host or an access token");
  }

  private name(collection: string, id: string) {
    if (!/^[A-Za-z0-9_]+$/.test(collection)) throw new Error(`Invalid collection name ${collection}`);
    if (!id || id.includes("/") || id === "." || id === "..") throw new Error("Invalid document id");
    return `${this.root}/${collection}/${id}`;
  }

  private async request(path: string, init: { method: string; body?: unknown }): Promise<Response> {
    const token = await this.token();
    try {
      return await this.fetcher(`${this.base}${path}`, {
        method: init.method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch {
      throw new StoreUnavailableError("Cannot reach the database");
    }
  }

  private async fail(res: Response): Promise<never> {
    const body = (await res.json().catch(() => ({}))) as { error?: { status?: string; message?: string } };
    const status = body.error?.status ?? "";
    if (
      res.status === 409 ||
      status === "ALREADY_EXISTS" ||
      status === "FAILED_PRECONDITION" ||
      status === "NOT_FOUND" ||
      status === "ABORTED"
    ) {
      throw new WriteConflictError(body.error?.message);
    }
    throw new StoreUnavailableError(
      `Database error (${res.status}${status ? ` ${status}` : ""}): ${body.error?.message ?? "unknown"}`,
    );
  }

  async get<T = Data>(collection: string, id: string): Promise<T | null> {
    this.name(collection, id);
    const path = `/${collection}/${encodeURIComponent(id)}`;
    const res = await this.request(path, { method: "GET" });
    if (res.status === 404) return null;
    if (!res.ok) return this.fail(res);
    const doc = (await res.json()) as { fields?: Record<string, FsValue> };
    return decodeFields(doc.fields ?? {}) as T;
  }

  private structuredQuery(collection: string, options: QueryOptions) {
    return clean({
      from: [{ collectionId: collection }],
      where: whereClause(options.where ?? []),
      orderBy: options.orderBy
        ? [
            {
              field: { fieldPath: options.orderBy.field },
              direction: options.orderBy.direction === "desc" ? "DESCENDING" : "ASCENDING",
            },
          ]
        : undefined,
      offset: options.offset || undefined,
      limit: options.limit,
    });
  }

  async query<T = Data>(collection: string, options: QueryOptions = {}): Promise<T[]> {
    const res = await this.request(":runQuery", {
      method: "POST",
      body: { structuredQuery: this.structuredQuery(collection, options) },
    });
    if (!res.ok) return this.fail(res);
    const rows = (await res.json()) as { document?: { fields?: Record<string, FsValue> } }[];
    return rows.filter((r) => r.document).map((r) => decodeFields(r.document!.fields ?? {}) as T);
  }

  async count(collection: string, where: Filter[] = []): Promise<number> {
    const res = await this.request(":runAggregationQuery", {
      method: "POST",
      body: {
        structuredAggregationQuery: {
          structuredQuery: this.structuredQuery(collection, { where }),
          aggregations: [{ alias: "n", count: {} }],
        },
      },
    });
    if (!res.ok) return this.fail(res);
    const rows = (await res.json()) as { result?: { aggregateFields?: { n?: FsValue } } }[];
    const n = rows[0]?.result?.aggregateFields?.n;
    return n ? Number(decodeValue(n)) : 0;
  }

  async commit(writes: Write[]): Promise<void> {
    if (writes.length === 0) return;
    if (writes.length > 500) throw new Error("A commit can hold at most 500 writes");
    const body = {
      writes: writes.map((w) => {
        const name = this.name(w.collection, w.id);
        if (w.type === "delete") return { delete: name };
        const fields = encodeFields(clean(w.data));
        if (w.type === "create") return { update: { name, fields }, currentDocument: { exists: false } };
        if (w.type === "set") return { update: { name, fields } };
        return {
          update: { name, fields },
          updateMask: { fieldPaths: Object.keys(fields).map(fieldPath) },
          currentDocument: { exists: true },
        };
      }),
    };
    const res = await this.request(":commit", { method: "POST", body });
    if (!res.ok) await this.fail(res);
  }
}

/** Field paths with characters outside [A-Za-z0-9_] must be backquoted. */
function fieldPath(name: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name.replace(/[`\\]/g, "\\$&")}\``;
}
