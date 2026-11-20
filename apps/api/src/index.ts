import { createFirebaseVerifier } from "@havins/auth";
import {
  C,
  FirestoreStore,
  MemoryStore,
  addressClaim,
  domainClaim,
  parseServiceAccount,
  type Store,
} from "@havins/database";
import { createEmailProvider, type EmailProvider } from "@havins/email-provider";
import { createApp } from "./app";
import { parseConfig, type Bindings, type Config, type Deps } from "./env";
import { createSealer } from "./services/crypto";
import { createTurnstileVerifier } from "./services/external";
import { purgeExpiredSessions } from "./services/sessions";

let cached: { env: Bindings; deps: Deps } | undefined;
/** The development memory store lives for the whole isolate, across requests. */
let memory: MemoryStore | undefined;

function createStore(env: Bindings, config: Config): Store {
  const kind = (env.DATA_STORE || "firestore").toLowerCase();
  if (kind === "memory") {
    if (config.environment !== "development")
      throw new Error("DATA_STORE=memory is only allowed in development");
    return (memory ??= new MemoryStore());
  }
  if (kind !== "firestore") throw new Error(`Unknown DATA_STORE "${kind}"`);
  if (env.FIRESTORE_EMULATOR_HOST) {
    if (config.environment !== "development")
      throw new Error("FIRESTORE_EMULATOR_HOST may only be set in development");
    return new FirestoreStore({
      projectId: env.FIREBASE_PROJECT_ID,
      emulatorHost: env.FIRESTORE_EMULATOR_HOST,
    });
  }
  const serviceAccount = parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT);
  if (!serviceAccount)
    throw new Error("FIREBASE_SERVICE_ACCOUNT is not set (wrangler secret put FIREBASE_SERVICE_ACCOUNT)");
  return new FirestoreStore({ projectId: serviceAccount.project_id, serviceAccount });
}

/** Development only: demo domain and two employees on the mock mail server. */
async function seedDevelopment(db: Store, provider: EmailProvider) {
  if (await db.get(C.claims, domainClaim("company.test"))) return;
  const now = Date.now();
  const domain = await provider.admin.createDomain("company.test");
  const domainId = crypto.randomUUID();
  await db.commit([
    {
      type: "create",
      collection: C.claims,
      id: domainClaim("company.test"),
      data: { id: domainClaim("company.test"), ownerType: "domain", ownerId: domainId },
    },
    {
      type: "create",
      collection: C.domains,
      id: domainId,
      data: {
        id: domainId,
        name: "company.test",
        status: "active",
        providerDomainId: domain.providerDomainId,
        providerRecords: JSON.stringify(domain.requiredRecords),
        createdAt: now,
      },
    },
  ]);
  for (const [localPart, displayName] of [
    ["priya", "Priya Sharma"],
    ["ravi", "Ravi Kumar"],
  ] as const) {
    const address = `${localPart}@company.test`;
    const { providerMailboxId } = await provider.admin.createMailbox({
      address,
      displayName,
      quotaMb: null,
      password: "Welcome-2026!",
    });
    const id = crypto.randomUUID();
    await db.commit([
      {
        type: "create",
        collection: C.claims,
        id: addressClaim(address),
        data: { id: addressClaim(address), ownerType: "mailbox", ownerId: id },
      },
      {
        type: "create",
        collection: C.mailboxes,
        id,
        data: {
          id,
          domainId,
          localPart,
          address,
          displayName,
          quotaMb: null,
          status: "active",
          providerMailboxId,
          lastError: null,
          lastLoginAt: null,
          createdAt: now,
        },
      },
    ]);
  }
}

/** Built once per isolate (bindings are stable for the isolate's lifetime). */
function buildDeps(env: Bindings): Deps {
  if (cached?.env === env) return cached.deps;
  const config = parseConfig(env);
  const emulator = env.FIREBASE_AUTH_EMULATOR === "true";
  if (emulator && config.environment !== "development") {
    throw new Error("FIREBASE_AUTH_EMULATOR may only be enabled in development");
  }
  const db = createStore(env, config);
  const sealer = createSealer(env.MAIL_SESSION_KEY);
  let provider: EmailProvider | undefined;
  const emailProvider = () =>
    (provider ??= createEmailProvider({
      environment: config.environment,
      provider: env.MAIL_PROVIDER,
      db,
      stalwart: {
        baseUrl: env.STALWART_URL,
        adminUser: env.STALWART_ADMIN_USER,
        adminPassword: env.STALWART_ADMIN_PASSWORD,
      },
    }));
  const seed =
    config.environment === "development" && env.DEV_SEED === "true" && db instanceof MemoryStore
      ? seedDevelopment(db, emailProvider()).catch((err: unknown) =>
          console.error("Development seed failed", err),
        )
      : undefined;
  const deps: Deps = {
    config,
    db,
    ready: seed,
    verifyIdToken: createFirebaseVerifier({
      projectId: env.FIREBASE_PROJECT_ID,
      allowEmulatorTokens: emulator,
    }),
    emailProvider,
    sealCredential: sealer.seal,
    openCredential: sealer.open,
    verifyTurnstile: createTurnstileVerifier(env.TURNSTILE_SECRET_KEY, config.environment),
    rateLimit: async (key) => {
      if (!env.RATE_LIMITER) return config.environment !== "production";
      return (await env.RATE_LIMITER.limit({ key })).success;
    },
    now: () => Date.now(),
  };
  cached = { env, deps };
  return deps;
}

const app = createApp(buildDeps);

export default {
  fetch: app.fetch,
  /** Daily cron (wrangler.jsonc triggers): remove expired sessions. */
  async scheduled(_event: unknown, env: Bindings) {
    const removed = await purgeExpiredSessions(buildDeps(env).db, Date.now());
    if (removed > 0) console.warn(`Purged ${removed} expired sessions`);
  },
};
