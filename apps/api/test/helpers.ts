import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { createFirebaseVerifier } from "@havins/auth";
import { createTestStore } from "@havins/database/testing";
import { MockEmailProvider, ProviderNotConfiguredError, type EmailProvider } from "@havins/email-provider";
import { createApp } from "../src/app";
import type { Deps } from "../src/env";
import { createSealer } from "../src/services/crypto";

export const ORIGIN = "https://admin.example.test";
const PROJECT = "test-project";
export const PASSWORD = "correct horse battery staple";

const keyPair = await generateKeyPair("RS256");
const jwks = createLocalJWKSet({
  keys: [{ ...(await exportJWK(keyPair.publicKey)), kid: "test", alg: "RS256" }],
});

function randomKey() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
}

export interface RequestOpts {
  cookie?: string;
  body?: unknown;
  origin?: string | null;
  raw?: { data: Uint8Array; type: string; filename: string };
}

export function createHarness(opts: { devMfaBypass?: boolean } = {}) {
  const db = createTestStore();
  const provider = new MockEmailProvider(db, { watchIntervalMs: 10, watchMaxChecks: 300 });
  const adminEmails: string[] = [];
  const clock = { now: Date.UTC(2026, 10, 20, 10, 0, 0) };
  let providerConfigured = true;
  const sealer = createSealer(randomKey());
  const limits = new Map<string, number>();
  let rateLimitMax = Infinity;

  const deps: Deps = {
    config: {
      environment: "development",
      appOrigins: [ORIGIN],
      companyName: "Test Co",
      adminEmails,
      devAllowAdminWithoutMfa: opts.devMfaBypass ?? false,
    },
    db,
    verifyIdToken: createFirebaseVerifier({
      projectId: PROJECT,
      keys: jwks,
      now: () => Math.floor(clock.now / 1000),
    }),
    emailProvider: (): EmailProvider => {
      if (!providerConfigured) throw new ProviderNotConfiguredError();
      return provider;
    },
    sealCredential: sealer.seal,
    openCredential: sealer.open,
    verifyTurnstile: async () => {},
    rateLimit: async (key) => {
      const n = (limits.get(key) ?? 0) + 1;
      limits.set(key, n);
      return n <= rateLimitMax;
    },
    now: () => clock.now,
  };
  const app = createApp(() => deps);

  const idToken = (uid: string, o: { mfa?: boolean; authAgeSec?: number } = {}) => {
    const nowSec = Math.floor(clock.now / 1000);
    return new SignJWT({
      email: `${uid}@example.com`,
      email_verified: true,
      auth_time: nowSec - (o.authAgeSec ?? 5),
      ...(o.mfa ? { firebase: { sign_in_second_factor: "totp" } } : {}),
    })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(`https://securetoken.google.com/${PROJECT}`)
      .setAudience(PROJECT)
      .setSubject(uid)
      .setIssuedAt(nowSec - 5)
      .setExpirationTime(nowSec + 3600)
      .sign(keyPair.privateKey);
  };

  const request = (method: string, path: string, o: RequestOpts = {}) => {
    const headers: Record<string, string> = {};
    if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
    if (o.cookie) headers.cookie = o.cookie;
    let body: RequestInit["body"];
    if (o.raw) {
      headers["content-type"] = o.raw.type;
      headers["x-filename"] = encodeURIComponent(o.raw.filename);
      body = o.raw.data as unknown as RequestInit["body"];
    } else if (o.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(o.body);
    }
    return Promise.resolve(app.request(path, { method, headers, body }, {}));
  };

  const cookieFrom = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;

  /** Firebase sign-in to the admin console; promote with makeAdmin. */
  const signIn = async (uid: string, o: { mfa?: boolean } = {}) => {
    const res = await request("POST", "/auth/session", { body: { idToken: await idToken(uid, o) } });
    if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
    return cookieFrom(res);
  };

  /** Admins come from ADMIN_EMAILS; the test identity's email is `<uid>@example.com`. */
  const makeAdmin = async (uid: string) => {
    adminEmails.push(`${uid}@example.com`);
  };

  /** Admin signed in with a second factor, ready to use the console. */
  const admin = async (uid = "boss") => {
    await signIn(uid);
    await makeAdmin(uid);
    return signIn(uid, { mfa: true });
  };

  const mailLogin = async (address: string, password = PASSWORD) => {
    const res = await request("POST", "/mail/login", { body: { address, password } });
    if (res.status !== 200) throw new Error(`mail login failed: ${res.status} ${await res.text()}`);
    return cookieFrom(res);
  };

  return {
    db,
    provider,
    clock,
    request,
    idToken,
    signIn,
    makeAdmin,
    admin,
    mailLogin,
    setProviderConfigured: (v: boolean) => {
      providerConfigured = v;
    },
    setRateLimit: (max: number) => {
      rateLimitMax = max;
      limits.clear();
    },
  };
}

export type Harness = ReturnType<typeof createHarness>;

export async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Admin ensures the domain exists and creates a mailbox on it. */
export async function setupMailbox(h: Harness, adminCookie: string, localPart: string, domain = "acme.test") {
  const list = await json<{ domains: { id: string; name: string }[] }>(
    await h.request("GET", "/admin/domains", { cookie: adminCookie }),
  );
  let domainId = list.domains.find((d) => d.name === domain)?.id;
  if (!domainId) {
    const res = await h.request("POST", "/admin/domains", { cookie: adminCookie, body: { name: domain } });
    if (res.status !== 201) throw new Error(`domain failed: ${res.status} ${await res.text()}`);
    domainId = (await json<{ domain: { id: string } }>(res)).domain.id;
  }
  const res = await h.request("POST", "/admin/mailboxes", {
    cookie: adminCookie,
    body: { domainId, localPart, displayName: localPart.toUpperCase(), password: PASSWORD },
  });
  if (res.status !== 201) throw new Error(`mailbox failed: ${res.status} ${await res.text()}`);
  const { mailbox } = await json<{ mailbox: { id: string; address: string } }>(res);
  return { domainId, mailboxId: mailbox.id, address: mailbox.address };
}
