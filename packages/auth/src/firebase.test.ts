import { describe, expect, it } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { createFirebaseVerifier, InvalidIdTokenError } from "./firebase";

const PROJECT = "demo-project";
const NOW = 1_800_000_000;

async function setup() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const verify = createFirebaseVerifier({
    projectId: PROJECT,
    keys: createLocalJWKSet({ keys: [jwk] }),
    now: () => NOW,
  });
  const sign = (claims: Record<string, unknown>, opts: { iss?: string; aud?: string; exp?: number } = {}) =>
    new SignJWT({ email: "a@example.com", email_verified: true, auth_time: NOW - 10, ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(opts.iss ?? `https://securetoken.google.com/${PROJECT}`)
      .setAudience(opts.aud ?? PROJECT)
      .setSubject("uid-1")
      .setIssuedAt(NOW - 10)
      .setExpirationTime(opts.exp ?? NOW + 3600)
      .sign(privateKey);
  return { verify, sign };
}

describe("Firebase ID token verification", () => {
  it("accepts a valid token and reports the second factor", async () => {
    const { verify, sign } = await setup();
    const identity = await verify(await sign({ firebase: { sign_in_second_factor: "totp" } }));
    expect(identity).toMatchObject({
      uid: "uid-1",
      email: "a@example.com",
      emailVerified: true,
      secondFactor: "totp",
    });
  });

  it("rejects tokens for another project", async () => {
    const { verify, sign } = await setup();
    await expect(verify(await sign({}, { aud: "other" }))).rejects.toBeInstanceOf(InvalidIdTokenError);
    await expect(
      verify(await sign({}, { iss: "https://securetoken.google.com/other" })),
    ).rejects.toBeInstanceOf(InvalidIdTokenError);
  });

  it("rejects expired tokens", async () => {
    const { verify, sign } = await setup();
    await expect(verify(await sign({}, { exp: NOW - 1 }))).rejects.toBeInstanceOf(InvalidIdTokenError);
  });

  it("rejects unsigned emulator tokens unless explicitly allowed", async () => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const claims = {
      iss: `https://securetoken.google.com/${PROJECT}`,
      aud: PROJECT,
      sub: "uid-2",
      email: "e@example.com",
      iat: NOW,
      exp: NOW + 60,
      auth_time: NOW,
    };
    const token = `${enc({ alg: "none", typ: "JWT" })}.${enc(claims)}.`;
    const strict = (await setup()).verify;
    await expect(strict(token)).rejects.toBeInstanceOf(InvalidIdTokenError);
    const emulator = createFirebaseVerifier({
      projectId: PROJECT,
      allowEmulatorTokens: true,
      now: () => NOW,
    });
    await expect(emulator(token)).resolves.toMatchObject({ uid: "uid-2" });
  });
});
