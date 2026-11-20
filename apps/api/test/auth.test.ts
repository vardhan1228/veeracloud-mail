import { describe, expect, it } from "vitest";
import { C } from "@havins/database";
import { isAdmin, parseConfig } from "../src/env";
import { createHarness, json } from "./helpers";

describe("admin authentication", () => {
  it("exchanges a Firebase ID token for a hardened, hashed session cookie", async () => {
    const h = createHarness();
    const res = await h.request("POST", "/auth/session", { body: { idToken: await h.idToken("alice") } });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^__Host-admin=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const raw = cookie.split(";")[0]!.split("=")[1]!;
    const [row] = await h.db.query<{ id: string }>(C.adminSessions);
    expect(row!.id).not.toBe(raw);
    expect(row!.id).toMatch(/^[0-9a-f]{64}$/);

    const me = await h.request("GET", "/auth/me", { cookie: cookie.split(";")[0] });
    expect(await json(me)).toMatchObject({
      user: { email: "alice@example.com", role: null },
      mfaVerified: false,
    });
  });

  it("rejects forged and stale tokens", async () => {
    const h = createHarness();
    const forged = (await h.idToken("mallory")).slice(0, -4) + "AAAA";
    expect((await h.request("POST", "/auth/session", { body: { idToken: forged } })).status).toBe(401);
    const stale = await h.request("POST", "/auth/session", {
      body: { idToken: await h.idToken("bob", { authAgeSec: 3600 }) },
    });
    expect(await json(stale)).toMatchObject({ code: "reauthentication_required" });
    expect((await h.request("GET", "/auth/me")).status).toBe(401);
  });

  it("only lets admins with a second factor into the console", async () => {
    const h = createHarness();
    const plain = await h.signIn("carol");
    expect(await json(await h.request("GET", "/admin/stats", { cookie: plain }))).toMatchObject({
      code: "forbidden",
    });

    await h.makeAdmin("carol");
    const noMfa = await h.request("GET", "/admin/stats", { cookie: plain });
    expect(noMfa.status).toBe(403);
    expect(await json(noMfa)).toMatchObject({ code: "mfa_required" });

    const withMfa = await h.signIn("carol", { mfa: true });
    expect((await h.request("GET", "/admin/stats", { cookie: withMfa })).status).toBe(200);
  });

  it("honours the development MFA bypass only when configured", async () => {
    const h = createHarness({ devMfaBypass: true });
    const cookie = await h.signIn("dev");
    await h.makeAdmin("dev");
    expect((await h.request("GET", "/admin/stats", { cookie })).status).toBe(200);

    const base = {
      APP_ORIGINS: "https://admin.example.test",
      FIREBASE_PROJECT_ID: "p",
      DEV_ALLOW_ADMIN_WITHOUT_MFA: "true",
    };
    expect(parseConfig({ ...base, ENVIRONMENT: "development" }).devAllowAdminWithoutMfa).toBe(true);
    expect(() => parseConfig({ ...base, ENVIRONMENT: "production" })).toThrow(/development/);
    expect(() => parseConfig({ ...base, ENVIRONMENT: "preview" })).toThrow(/development/);
  });

  it("logs out, expires sessions and blocks disabled accounts", async () => {
    const h = createHarness();
    const cookie = await h.signIn("dave");
    expect((await h.request("POST", "/auth/logout", { cookie })).status).toBe(200);
    expect((await h.request("GET", "/auth/me", { cookie })).status).toBe(401);

    const again = await h.signIn("dave");
    h.clock.now += 13 * 60 * 60 * 1000;
    expect((await h.request("GET", "/auth/me", { cookie: again })).status).toBe(401);

    await h.db.commit([{ type: "update", collection: C.users, id: "dave", data: { status: "disabled" } }]);
    const blocked = await h.request("POST", "/auth/session", { body: { idToken: await h.idToken("dave") } });
    expect(blocked.status).toBe(403);
  });

  it("rejects state-changing requests from other origins and sets strict headers", async () => {
    const h = createHarness();
    const cookie = await h.admin();
    const body = { name: "evil.test" };
    expect(
      (await h.request("POST", "/admin/domains", { cookie, body, origin: "https://evil.example" })).status,
    ).toBe(403);
    expect((await h.request("POST", "/admin/domains", { cookie, body, origin: null })).status).toBe(403);
    const ok = await h.request("GET", "/health");
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://admin.example.test");
    expect(ok.headers.get("content-security-policy")).toContain("default-src 'none'");
    const bad = await h.request("GET", "/health", { origin: "https://evil.example" });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("grants the admin role only to configured, verified emails", () => {
    const base = {
      ENVIRONMENT: "production",
      APP_ORIGINS: "https://admin.example.test",
      FIREBASE_PROJECT_ID: "p",
      ADMIN_EMAILS: " Boss@Example.com ,bad",
    };
    const config = parseConfig(base);
    expect(config.adminEmails).toEqual(["boss@example.com"]);
    const user = {
      id: "u",
      email: "boss@example.com",
      emailVerified: true,
      displayName: null,
      status: "active" as const,
      lastLoginAt: null,
      createdAt: 0,
    };
    expect(isAdmin(config, user)).toBe(true);
    expect(isAdmin(config, { ...user, emailVerified: false })).toBe(false);
    expect(isAdmin(config, { ...user, status: "disabled" })).toBe(false);
    expect(isAdmin(config, { ...user, email: "someone@example.com" })).toBe(false);
    expect(isAdmin({ ...config, environment: "development" }, { ...user, emailVerified: false })).toBe(true);
  });
});
