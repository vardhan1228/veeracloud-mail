import type { RateLimit } from "@cloudflare/workers-types";
import type { FirebaseVerifier } from "@havins/auth";
import type { MailboxRecord, Store, UserRecord } from "@havins/database";
import type { EmailProvider, MailClient } from "@havins/email-provider";

export type Environment = "development" | "preview" | "production";

/** Worker bindings, as declared in wrangler.jsonc plus secrets. */
export interface Bindings {
  ENVIRONMENT: string;
  APP_ORIGINS: string;
  COMPANY_NAME?: string;
  FIREBASE_PROJECT_ID: string;
  FIREBASE_AUTH_EMULATOR?: string;
  /** Comma-separated admin console emails. The only way to become an admin. */
  ADMIN_EMAILS?: string;
  /** "firestore" (default) or "memory" (development only, data lost on restart). */
  DATA_STORE?: string;
  /** Secret: the whole Firebase service-account key JSON. */
  FIREBASE_SERVICE_ACCOUNT?: string;
  /** Development only: "localhost:8080" to use the Firestore emulator. */
  FIRESTORE_EMULATOR_HOST?: string;
  /** "stalwart", "mock" (development/preview) or "none". */
  MAIL_PROVIDER?: string;
  STALWART_URL?: string;
  /** Secret. */
  STALWART_ADMIN_USER?: string;
  /** Secret. */
  STALWART_ADMIN_PASSWORD?: string;
  /** Secret: base64 of 32 random bytes; encrypts mailbox passwords held in webmail sessions. */
  MAIL_SESSION_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  RATE_LIMITER?: RateLimit;
  /** Development only: lets admins use the console without a second factor. */
  DEV_ALLOW_ADMIN_WITHOUT_MFA?: string;
  /** Development only, memory store only: creates demo mailboxes at start-up. */
  DEV_SEED?: string;
}

export interface Config {
  environment: Environment;
  appOrigins: string[];
  companyName: string;
  /** Lower-case. */
  adminEmails: string[];
  devAllowAdminWithoutMfa: boolean;
}

/** Everything a route needs from the outside world, injectable for tests. */
export interface Deps {
  config: Config;
  db: Store;
  /** Resolves once start-up work (development seed) is done. */
  ready?: Promise<void>;
  verifyIdToken: FirebaseVerifier;
  /** Throws ProviderNotConfiguredError when no mail server is set up. */
  emailProvider: () => EmailProvider;
  /** AES-GCM for webmail session credentials. Throws if MAIL_SESSION_KEY is missing. */
  sealCredential: (plain: string) => Promise<string>;
  openCredential: (sealed: string) => Promise<string>;
  verifyTurnstile: (token: string | undefined, ip: string | null) => Promise<void>;
  /** Returns false when `key` has exceeded its limit. */
  rateLimit: (key: string) => Promise<boolean>;
  now: () => number;
}

export interface Vars {
  deps: Deps;
  user: UserRecord | null;
  sessionId: string | null;
  mfaVerified: boolean;
  mailbox: MailboxRecord | null;
  mailSessionId: string | null;
  mail: MailClient;
}

export type AppEnv = { Bindings: Bindings; Variables: Vars };

export function parseConfig(env: Bindings): Config {
  const environment = env.ENVIRONMENT;
  if (environment !== "development" && environment !== "preview" && environment !== "production") {
    throw new Error(`ENVIRONMENT must be development, preview or production (got "${environment}")`);
  }
  const appOrigins = (env.APP_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  for (const origin of appOrigins) {
    const url = new URL(origin);
    if (url.origin !== origin) throw new Error(`APP_ORIGINS entry "${origin}" must be a bare origin`);
    if (environment === "production" && url.protocol !== "https:") {
      throw new Error("APP_ORIGINS must use https in production");
    }
  }
  const devAllowAdminWithoutMfa = env.DEV_ALLOW_ADMIN_WITHOUT_MFA === "true";
  if (devAllowAdminWithoutMfa && environment !== "development") {
    throw new Error("DEV_ALLOW_ADMIN_WITHOUT_MFA may only be enabled in development");
  }
  const adminEmails = (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes("@"));
  return {
    environment,
    appOrigins,
    companyName: env.COMPANY_NAME || "HAVINS TECHNOLOGIES",
    adminEmails,
    devAllowAdminWithoutMfa,
  };
}

/**
 * Admins are the configured ADMIN_EMAILS. Outside development the Firebase email must be
 * verified, so nobody can claim an admin address by signing up with it.
 */
export function isAdmin(config: Config, user: UserRecord): boolean {
  return (
    user.status === "active" &&
    config.adminEmails.includes(user.email.toLowerCase()) &&
    (user.emailVerified || config.environment === "development")
  );
}
